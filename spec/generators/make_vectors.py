"""Writes spec/vectors.json: Bead's conformance vectors, the one source every implementation's tests read."""
import json
import os
import re

from spec_version import spec_version

# the conformance files sit one folder up from their generators
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vectors.json')

TOKEN_BYTES = '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'
ZEROS = '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'

MALFORMED = 1
LAYOUT_UNSUPPORTED = 2
KIND_UNSUPPORTED = 3
ENVELOPE_TOO_LARGE = 4


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


def ascii_hex(text):
    return hexadecimal(text.encode('utf-8'))


# ── The CREDENTIAL block ────────────────────────────────────────────────────────────────────────

NONE, OPAQUE, JWT, ELSEWHERE = 0, 1, 2, 3


def block(scheme, data=b''):
    """A CREDENTIAL block: its scheme and its length, 2 bytes each, its credential's bytes, then zero
    bytes to the next word."""
    parts = (hexadecimal(scheme.to_bytes(2, 'big') + len(data).to_bytes(2, 'big')), hexadecimal(data),
             hexadecimal(bytes(-len(data) % 4)))
    return '  '.join(part for part in parts if part)


def header_of(kind, flags, call_id, *parts, words=None):
    """A header, its parts after the prefix in their order, byte 3 counting them, or the words given."""
    length = 8 + sum(len(part.split()) for part in parts)
    words = length // 4 if words is None else words
    return '  '.join([f'A1 {kind:02X} {flags:02X} {words:02X}', hexadecimal(call_id.to_bytes(4, 'big')), *parts])


def parted(data, at):
    """Bytes with the bar after the header byte 3 counts, `at` bytes from the start."""
    start = [found.start() for found in re.finditer(r'[0-9A-F]{2}', data)][at]
    return data[:start].rstrip() + ' | ' + data[start:]


def jws_of(length):
    """A token of `length` characters, shaped as JWS Compact Serialization writes one: a protected
    header, {"alg":"HS256"}, a payload of filler, and a signature of HS256's 43 characters."""
    return 'eyJhbGciOiJIUzI1NiJ9.' + 'A' * (length - 65) + '.' + 'B' * 43


# the JWS of RFC 7515, appendix A.1: 179 characters, padded with one zero byte
RFC_7515_JWS = ('eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9'
                '.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ'
                '.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')

# what a header leaves a credential: its 1,020 bytes less a request's 12 and its block's head of 4;
# behind a destination and a total, 12 more
MOST_JWT, MOST_JWT_BEHIND_BLOCKS = 1004, 992

OPAQUE_BLOCK = block(OPAQUE, bytes(range(16)))
SESSION = {'scheme': 'OPAQUE', 'bytes': TOKEN_BYTES}
ENDED = {'scheme': 'NONE'}


headers = [
    ('a request', ['2.1', '3.1.1'], 'A1 10 00 03  00 00 00 03  00 02 00 01', {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a result', ['2.1', '3.1.2'], 'A1 11 00 02  00 00 00 03', {'callId': 3, 'kind': 17}),
    ('a failure', ['2.1', '3.1.3'], 'A1 12 00 02  00 00 00 03', {'callId': 3, 'kind': 18}),
    ('a notification', ['2.1', '3.1.4'], 'A1 13 00 02  00 00 00 0D', {'callId': 13, 'kind': 19}),
    ('a cancel', ['2.1', '3.1.7'], 'A1 16 00 02  00 00 00 05', {'callId': 5, 'kind': 22}),
    ('a request with a destination', ['4.1', '4.5'], 'A1 10 02 04  00 00 00 09  00 02 00 07  00 00 00 05',
     {'callId': 9, 'destinationId': 5, 'kind': 16, 'procedureId': 7, 'serviceId': 2}),
    # the CREDENTIAL block, the last: a credential of each scheme on the kinds that take it
    ('a request presenting an opaque token', ['4.1', '4.4', '4.4.2'], f'A1 10 08 08  00 00 00 03  00 02 00 01  {OPAQUE_BLOCK}',
     {'callId': 3, 'credential': SESSION, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a result announcing a session', ['4.1', '4.2.2', '4.4.2', '13.3'], f'A1 11 08 07  00 00 00 03  {OPAQUE_BLOCK}',
     {'callId': 3, 'credential': SESSION, 'kind': 17}),
    ('a result announcing that its session ended', ['4.4.1', '13.3'], 'A1 11 08 03  00 00 00 03  00 00 00 00',
     {'callId': 3, 'credential': ENDED, 'kind': 17}),
    ('a failure announcing a session', ['4.2.3', '4.4.2'], f'A1 12 08 07  00 00 00 03  {OPAQUE_BLOCK}',
     {'callId': 3, 'credential': SESSION, 'kind': 18}),
    ('a failure announcing that its session ended', ['4.2.3', '4.4.1'], 'A1 12 08 03  00 00 00 03  00 00 00 00',
     {'callId': 3, 'credential': ENDED, 'kind': 18}),
    ('a request with a destination, presenting an opaque token after it', ['4.1', '4.4.2', '4.5'],
     f'A1 10 0A 09  00 00 00 07  00 02 00 01  00 00 00 0C  {OPAQUE_BLOCK}',
     {'callId': 7, 'credential': SESSION, 'destinationId': 12, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request presenting a JWT, padded with one zero byte to its word', ['4.4', '4.4.3'],
     header_of(0x10, 0x08, 3, '00 02 00 01', block(JWT, RFC_7515_JWS.encode('ascii'))),
     {'callId': 3, 'credential': {'scheme': 'JWT', 'token': RFC_7515_JWS}, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request presenting a JWT of one byte, the least, padded with three', ['4.4', '4.4.3'],
     'A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  61  00 00 00',
     {'callId': 3, 'credential': {'scheme': 'JWT', 'token': 'a'}, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request presenting a JWT of 1,004 bytes, the most its header leaves', ['4.3', '4.4', '4.4.3'],
     header_of(0x10, 0x08, 3, '00 02 00 01', block(JWT, jws_of(MOST_JWT).encode('ascii'))),
     {'callId': 3, 'credential': {'scheme': 'JWT', 'token': jws_of(MOST_JWT)}, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request with a destination and a total, presenting a JWT after them', ['4.1', '4.4.3', '4.5', '4.6'],
     header_of(0x10, 0x0E, 9, '00 02 00 07', '00 00 00 05', '00 00 00 00 00 00 10 00', block(JWT, RFC_7515_JWS.encode('ascii'))),
     {'callId': 9, 'credential': {'scheme': 'JWT', 'token': RFC_7515_JWS}, 'destinationId': 5, 'kind': 16, 'procedureId': 7,
      'serviceId': 2, 'total': 4096}),
    ('a request with a destination and a total, presenting a JWT of 992 bytes, the most its header leaves', ['4.3', '4.4', '4.4.3'],
     header_of(0x10, 0x0E, 9, '00 02 00 07', '00 00 00 05', '00 00 00 00 00 00 10 00',
               block(JWT, jws_of(MOST_JWT_BEHIND_BLOCKS).encode('ascii'))),
     {'callId': 9, 'credential': {'scheme': 'JWT', 'token': jws_of(MOST_JWT_BEHIND_BLOCKS)}, 'destinationId': 5, 'kind': 16,
      'procedureId': 7, 'serviceId': 2, 'total': 4096}),
    ('a request presenting ELSEWHERE, nothing in its block', ['4.4.4'], 'A1 10 08 04  00 00 00 03  00 02 00 01  00 03 00 00',
     {'callId': 3, 'credential': {'scheme': 'ELSEWHERE'}, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request presenting a scheme to come, read whole and padded with two', ['4.4.5'],
     'A1 10 08 06  00 00 00 03  00 02 00 01  00 04 00 06  01 02 03 04 05 06  00 00',
     {'callId': 3, 'credential': {'scheme': 4, 'bytes': '01 02 03 04 05 06'}, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request presenting the last scheme to come, with no byte', ['1.1', '4.4.5'], 'A1 10 08 04  00 00 00 03  00 02 00 01  FF FF 00 00',
     {'callId': 3, 'credential': {'scheme': 65535, 'bytes': ''}, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a request that opens a subscription', ['4.1', '4.8'], 'A1 10 10 03  00 00 00 03  00 02 00 01',
     {'callId': 3, 'kind': 16, 'opensSubscription': True, 'procedureId': 1, 'serviceId': 2}),
    ('a request that opens a subscription, paced', ['4.8'], 'A1 10 30 03  00 00 00 05  00 02 00 01',
     {'callId': 5, 'kind': 16, 'opensSubscription': True, 'paced': True, 'procedureId': 1, 'serviceId': 2}),
    ('a request that opens a subscription, with a destination, presenting an opaque token', ['4.1', '4.4.2', '4.5', '4.8'],
     f'A1 10 1A 09  00 00 00 07  00 02 00 01  00 00 00 0C  {OPAQUE_BLOCK}',
     {'callId': 7, 'credential': SESSION, 'destinationId': 12, 'kind': 16, 'opensSubscription': True, 'procedureId': 1, 'serviceId': 2}),
    ('a request that opens a transfer', ['4.6'], 'A1 10 04 05  00 00 00 07  00 02 00 05  00 00 00 00 01 40 00 00',
     {'callId': 7, 'kind': 16, 'procedureId': 5, 'serviceId': 2, 'total': 20971520}),
    ('a request with a destination that opens a transfer of nothing', ['4.1', '4.5', '4.6'],
     'A1 10 06 06  00 00 00 09  00 02 00 07  00 00 00 05  00 00 00 00 00 00 00 00',
     {'callId': 9, 'destinationId': 5, 'kind': 16, 'procedureId': 7, 'serviceId': 2, 'total': 0}),
    ('a result that opens a transfer, announcing a session after its total', ['4.1', '4.4.2', '4.6'],
     f'A1 11 0C 09  00 00 00 03  00 00 00 00 00 00 10 00  {OPAQUE_BLOCK}',
     {'callId': 3, 'credential': SESSION, 'kind': 17, 'total': 4096}),
    ('a chunk with more to come', ['3.1.5', '4.9'], 'A1 14 40 04  00 00 00 07  00 00 00 00 00 0F FF EC',
     {'callId': 7, 'isLast': False, 'kind': 20, 'offset': 1048556}),
    ('the last chunk', ['3.1.5', '4.9'], 'A1 14 00 04  00 00 00 07  00 00 00 00 01 3F FE BC',
     {'callId': 7, 'isLast': True, 'kind': 20, 'offset': 20971196}),
    ('a credit', ['3.1.6'], 'A1 15 00 04  00 00 00 07  00 00 00 00 00 4F FF EC', {'callId': 7, 'creditEnd': 5242860, 'kind': 21}),
    ('a credit of notifications', ['3.1.6', '4.8'], 'A1 15 20 04  00 00 00 05  00 00 00 00 00 00 00 03',
     {'callId': 5, 'creditEnd': 3, 'kind': 21, 'paced': True}),
    # the call ids past 2^31, unsigned, and the largest of each 64-bit field
    ('a result on the last call id', ['1.1', '3.5'], 'A1 11 00 02  FF FF FF FF', {'callId': 4294967295, 'kind': 17}),
    ('a request at the last of every range', ['1.1', '4.5'], 'A1 10 02 04  FF FF FF FF  FF FF FF FF  FF FF FF FF',
     {'callId': 4294967295, 'destinationId': 4294967295, 'kind': 16, 'procedureId': 65535, 'serviceId': 65535}),
    ('a credit at 2^53 - 1, the largest end', ['1.2'], 'A1 15 00 04  00 00 00 07  00 1F FF FF FF FF FF FF',
     {'callId': 7, 'creditEnd': 9007199254740991, 'kind': 21}),
    ('a credit past 2^32, its high word first', ['1.1', '1.2'], 'A1 15 00 04  00 00 00 01  00 00 00 01 00 00 00 05',
     {'callId': 1, 'creditEnd': 4294967301, 'kind': 21}),
]

# headers a reader takes, which a writer need not write: what it reads, or null for a kind skipped
reads = [
    ('a request opening a transfer of 40 MiB', ['4.6'], 'server', 'A1 10 04 05  00 00 00 03  00 02 00 01  00 00 00 00 02 80 00 00',
     {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2, 'total': 41943040}),
    ('a result opening a transfer of nothing, read by a client', ['4.6'], 'client', 'A1 11 04 04  00 00 00 02  00 00 00 00 00 00 00 00',
     {'callId': 2, 'kind': 17, 'total': 0}),
    ('a request to service 0, for routing to refuse', ['4.7'], 'server', 'A1 10 00 03  00 00 00 03  00 00 00 01',
     {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 0}),
    ('an advisory kind, skipped', ['3.4', '5.1.4'], 'server', 'A1 80 00 02  00 00 00 03', None),
    ('the last advisory kind, skipped whatever follows', ['3.4', '5.1.4'], 'server', 'A1 FF FF FF  00 00 00 00', None),
]

# the first 8 bytes, read by every layout, even one to come
prefixes = [
    ('the prefix of a layout to come', ['2.1', '2.4'], 'AF 7E 55 00  80 00 00 01', {'callId': 2147483649, 'kind': 126, 'layout': 175}),
]

prefix_refusals = [
    ('no byte at all', ['2.2', '5.1.1'], ''),
    ('7 bytes', ['2.2', '5.1.1'], 'A1 10 00 03  00 00 00'),
    ('a first byte of 0x0A', ['2.2', '5.1.1'], '0A 10 00 03  00 00 00 03'),
    ('a first byte of 0x00', ['2.2', '5.1.1'], '00 10 00 03  00 00 00 03'),
    ('a first byte of 0xA0', ['2.2', '5.1.1'], 'A0 10 00 03  00 00 00 03'),
    ('a first byte of 0xB0', ['2.2', '5.1.1'], 'B0 10 00 03  00 00 00 03'),
]

header_refusals = [
    ('a layout to come, 0xA2', ['2.3', '5.1.3'], 'A2 10 00 03  00 00 00 03  00 02 00 01', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a layout to come, 0xAF', ['2.3', '5.1.3'], 'AF 10 00 03  00 00 00 03  00 02 00 01', LAYOUT_UNSUPPORTED, '0xA1'),
    # the order a reader checks in: the layout, then the kind, then the call id
    ('a layout to come, before a kind that is never one and a call id of 0', ['2.3', '5.1.3'], 'A2 00 00 02  00 00 00 00', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a layout to come, before an advisory kind', ['2.3', '5.1.3'], 'A2 80 00 02  00 00 00 03', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a kind to come, before a call id of 0', ['3.3', '5.1.6'], 'A1 17 00 02  00 00 00 00', KIND_UNSUPPORTED, None),
    ('a kind of 0x00, never one', ['3.2', '5.1.5'], 'A1 00 00 02  00 00 00 03', MALFORMED, None),
    ('a kind of 0x0F, never one', ['3.2', '5.1.5'], 'A1 0F 00 02  00 00 00 03', MALFORMED, None),
    ('a kind to come, 0x17', ['3.3', '5.1.6'], 'A1 17 00 02  00 00 00 03', KIND_UNSUPPORTED, None),
    ('a kind to come, 0x7F', ['3.3', '5.1.6'], 'A1 7F 00 02  00 00 00 03', KIND_UNSUPPORTED, None),
    ('a call id of 0', ['3.5', '5.1.7'], 'A1 11 00 02  00 00 00 00', MALFORMED, None),
    ('the kept bit 0x01 on a request, 16 bytes after its procedure', ['4.1', '4.2.1'], f'A1 10 01 07  00 00 00 03  00 02 00 01  {TOKEN_BYTES}',
     MALFORMED, 'a 0x10 envelope carries no flag 0x01'),
    ('the kept bit 0x01 on a result, 16 bytes after its prefix', ['4.1', '4.2.2'], f'A1 11 01 06  00 00 00 03  {TOKEN_BYTES}',
     MALFORMED, 'a 0x11 envelope carries no flag 0x01'),
    ('the kept bit 0x01 on a failure, 16 bytes after its prefix', ['4.1', '4.2.3'], f'A1 12 01 06  00 00 00 03  {TOKEN_BYTES}',
     MALFORMED, 'a 0x12 envelope carries no flag 0x01'),
    ('the bit 0x40 on a request', ['4.2.1'], 'A1 10 40 03  00 00 00 03  00 02 00 01', MALFORMED, None),
    ('the reserved bit 0x80 on a request', ['4.1', '4.2.1'], 'A1 10 80 03  00 00 00 03  00 02 00 01', MALFORMED, None),
    ('a request paced that opens no subscription', ['4.8'], 'A1 10 20 03  00 00 00 03  00 02 00 01', MALFORMED,
     'a request paced opens a subscription'),
    ('a total of 2^53, no safe integer', ['1.2'], 'A1 11 04 04  00 00 00 02  00 20 00 00 00 00 00 00', MALFORMED, None),
    ('a total not counted in the header length', ['4.3'], 'A1 10 04 03  00 00 00 03  00 02 00 01  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a total on a failure', ['4.2.3'], 'A1 12 04 04  00 00 00 03  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a total on a notification', ['4.2.4'], 'A1 13 04 04  00 00 00 03  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a destination on a result', ['4.2.2', '4.5'], 'A1 11 02 03  00 00 00 03  00 00 00 05', MALFORMED, None),
    ('a destination on a failure', ['4.2.3', '4.5'], 'A1 12 02 03  00 00 00 03  00 00 00 05', MALFORMED, None),
    ('a credential on a cancel', ['4.2.7'], f'A1 16 08 07  00 00 00 05  {OPAQUE_BLOCK}', MALFORMED, 'a 0x16 envelope carries no flag 0x08'),
    ('a destination on a cancel', ['4.2.7'], 'A1 16 02 03  00 00 00 05  00 00 00 07', MALFORMED, None),
    ('a total on a cancel', ['4.2.7'], 'A1 16 04 04  00 00 00 05  00 00 00 00 00 00 00 08', MALFORMED, None),
    ('an offset of 2^53', ['1.2'], 'A1 14 00 04  00 00 00 07  00 20 00 00 00 00 00 00', MALFORMED, None),
    ('an end of 2^64 - 1', ['1.2'], 'A1 15 00 04  00 00 00 07  FF FF FF FF FF FF FF FF', MALFORMED, None),
    ('a chunk on call 0', ['3.5'], 'A1 14 00 04  00 00 00 00  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a credit on call 0', ['3.5'], 'A1 15 00 04  00 00 00 00  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a credential on a chunk', ['4.2.5'], f'A1 14 08 09  00 00 00 07  00 00 00 00 00 00 00 00  {OPAQUE_BLOCK}',
     MALFORMED, 'a 0x14 envelope carries no flag 0x08'),
    ('a credential on a credit', ['4.2.6'], f'A1 15 08 09  00 00 00 07  00 00 00 00 00 00 00 00  {OPAQUE_BLOCK}',
     MALFORMED, 'a 0x15 envelope carries no flag 0x08'),
    ('a total on a credit', ['4.2.6'], 'A1 15 04 06  00 00 00 07  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 10', MALFORMED, None),
    ('MORE on a credit', ['4.2.6'], 'A1 15 40 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('the kept bit 0x01 on a chunk', ['4.1', '4.2.5'], 'A1 14 01 04  00 00 00 07  00 00 00 00 00 00 00 00',
     MALFORMED, 'a 0x14 envelope carries no flag 0x01'),
    ('PACED on a chunk', ['4.2.5'], 'A1 14 20 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('SUBSCRIPTION on a credit', ['4.2.6'], 'A1 15 10 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('MORE on a result', ['4.2.2'], 'A1 11 40 02  00 00 00 07', MALFORMED, None),
] + [
    (f'{flag_name} on a {kind_name}', [row], f'A1 {kind} {flag} 02  00 00 00 03', MALFORMED, None)
    for kind, kind_name, row in (('11', 'result', '4.2.2'), ('12', 'failure', '4.2.3'),
                                 ('13', 'notification', '4.2.4'), ('16', 'cancel', '4.2.7'))
    for flag, flag_name in (('10', 'SUBSCRIPTION'), ('20', 'PACED'))
] + [
    ('a credential on a notification', ['4.2.4'], f'A1 13 08 07  00 00 00 03  {OPAQUE_BLOCK}', MALFORMED, 'a 0x13 envelope carries no flag 0x08'),
    ('a destination on a notification', ['4.2.4'], 'A1 13 02 03  00 00 00 03  00 00 00 05', MALFORMED, None),
] + [
    (f'a header length of {words} words, not its blocks\'', ['4.3'], f'A1 10 00 {words}  00 00 00 03  00 02 00 01  00 00 00 00', MALFORMED, None)
    for words in ('00', '01', '02', '04')
] + [
    ('a header running past the message', ['4.3'], 'A1 10 00 03  00 00 00 03  00 02', MALFORMED, None),
    ('a destination running past the message', ['4.3'], 'A1 10 02 04  00 00 00 03  00 02 00 01  00 00', MALFORMED, None),
    ('a destination of 0', ['4.5'], 'A1 10 02 04  00 00 00 03  00 02 00 01  00 00 00 00', MALFORMED, None),
    ('a procedure of 0', ['4.7'], 'A1 10 00 03  00 00 00 03  00 02 00 00', MALFORMED, None),
    # the CREDENTIAL block: a scheme on a kind that does not take it
    ('NONE on a request', ['4.4', '4.4.1'], 'A1 10 08 04  00 00 00 03  00 02 00 01  00 00 00 00',
     MALFORMED, 'a request presents a credential, never NONE'),
    ('a JWT on a result', ['4.4.3'], 'A1 11 08 04  00 00 00 03  00 02 00 01  61  00 00 00', MALFORMED, 'an answer announces OPAQUE or NONE, not JWT'),
    ('a JWT on a failure', ['4.4.3'], 'A1 12 08 04  00 00 00 03  00 02 00 01  61  00 00 00',
     MALFORMED, 'an answer announces OPAQUE or NONE, not JWT'),
    ('ELSEWHERE on a result', ['4.4.4'], 'A1 11 08 03  00 00 00 03  00 03 00 00', MALFORMED, 'an answer announces OPAQUE or NONE, not ELSEWHERE'),
    ('ELSEWHERE on a failure', ['4.4.4'], 'A1 12 08 03  00 00 00 03  00 03 00 00', MALFORMED, 'an answer announces OPAQUE or NONE, not ELSEWHERE'),
    ('the first scheme to come on a result', ['4.4.5'], 'A1 11 08 03  00 00 00 03  00 04 00 00',
     MALFORMED, 'an answer announces OPAQUE or NONE, not scheme 4'),
    ('the last scheme to come on a failure, with bytes', ['4.4.5'], 'A1 12 08 04  00 00 00 03  FF FF 00 02  01 02  00 00',
     MALFORMED, 'an answer announces OPAQUE or NONE, not scheme 65535'),
    # a length that is not its scheme's, each block padded to its word
    ('an opaque token of 16 zero bytes on a request', ['4.4', '4.4.2', '13.2'], f'A1 10 08 08  00 00 00 03  00 02 00 01  00 01 00 10  {ZEROS}',
     MALFORMED, 'an OPAQUE token is never all zero'),
    ('an opaque token of 16 zero bytes on a result', ['4.4.2', '13.2'], f'A1 11 08 07  00 00 00 03  00 01 00 10  {ZEROS}',
     MALFORMED, 'an OPAQUE token is never all zero'),
    ('an opaque token of 15 bytes', ['4.4.2'], header_of(0x10, 0x08, 3, '00 02 00 01', block(OPAQUE, bytes(range(1, 16)))),
     MALFORMED, 'an OPAQUE token is 16 bytes, not 15'),
    ('an opaque token of 17 bytes', ['4.4.2'], header_of(0x10, 0x08, 3, '00 02 00 01', block(OPAQUE, bytes(range(1, 18)))),
     MALFORMED, 'an OPAQUE token is 16 bytes, not 17'),
    ('an opaque token of no byte, on a result', ['4.4.2'], 'A1 11 08 03  00 00 00 03  00 01 00 00', MALFORMED, 'an OPAQUE token is 16 bytes, not 0'),
    ('a JWT of no byte', ['4.4.3'], 'A1 10 08 04  00 00 00 03  00 02 00 01  00 02 00 00', MALFORMED, 'a JWT is 1 byte at least'),
    ('ELSEWHERE with 4 bytes', ['4.4.4'], 'A1 10 08 05  00 00 00 03  00 02 00 01  00 03 00 04  01 02 03 04',
     MALFORMED, 'ELSEWHERE holds no byte, not 4'),
    ('NONE with 4 bytes, on a result', ['4.4.1'], 'A1 11 08 04  00 00 00 03  00 00 00 04  00 00 00 00', MALFORMED, 'NONE holds no byte, not 4'),
    # padding that is not zero
    ('a JWT whose padding is not zero', ['4.4'], 'A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  61  00 00 01',
     MALFORMED, "a credential's padding is zero bytes"),
    ('a scheme to come whose padding is not zero', ['4.4'], 'A1 10 08 06  00 00 00 03  00 02 00 01  00 04 00 05  01 02 03 04 05  80 00 00',
     MALFORMED, "a credential's padding is zero bytes"),
    # a block past the header's length, which counts it to the end of its padding exactly
    ('CREDENTIAL on a request whose message ends before its block', ['4.3'], 'A1 10 08 03  00 00 00 03  00 02 00 01',
     MALFORMED, "a 0x10 header of flags 0x08 holds its credential's head: 16 bytes at least, not 12"),
    ("a block whose head the header's length does not hold, though the message does", ['4.3'],
     'A1 10 08 03  00 00 00 03  00 02 00 01 | 00 03 00 00',
     MALFORMED, "a 0x10 header of flags 0x08 holds its credential's head: 16 bytes at least, not 12"),
    ('a JWT running past the message', ['4.3', '4.4'], 'A1 10 08 06  00 00 00 03  00 02 00 01  00 02 00 64  61 62 63 64  65 66 67 68',
     MALFORMED, 'a 0x10 header of flags 0x08 is 116 bytes, not 24 of 24'),
    ("a JWT running past the header's length, within the message", ['4.3', '4.4'],
     parted(header_of(0x10, 0x08, 3, '00 02 00 01', block(JWT, b'abcdefghijklmnopqrstuvwxyz012345'), words=6), 24),
     MALFORMED, 'a 0x10 header of flags 0x08 is 48 bytes, not 24 of 48'),
    ('a JWT past the 1,020 bytes a header holds', ['4.3', '4.4'],
     parted(header_of(0x10, 0x08, 3, '00 02 00 01', block(JWT, jws_of(MOST_JWT + 1).encode('ascii')), words=0xFF), 1020),
     MALFORMED, 'a 0x10 header of flags 0x08 is 1024 bytes, not 1020 of 1024'),
    ("a header a word longer than its block's padded end", ['4.3'],
     'A1 10 08 06  00 00 00 03  00 02 00 01  00 02 00 01  61  00 00 00  00 00 00 00',
     MALFORMED, 'a 0x10 header of flags 0x08 is 20 bytes, not 24 of 24'),
    ('a block whose stated length leaves byte 3 a word short', ['4.3'],
     'A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 05  61 62 63 64 | 65 00 00 00',
     MALFORMED, 'a 0x10 header of flags 0x08 is 24 bytes, not 20 of 24'),
    ('an announcement whose header is a word short of its block', ['4.3', '4.4.2'],
     parted(f'A1 11 08 06  00 00 00 03  {OPAQUE_BLOCK}', 24), MALFORMED, 'a 0x11 header of flags 0x08 is 28 bytes, not 24 of 28'),
]

envelopes = [
    ('a request, 14 bytes for 3/2/1 and "hi"', ['6.1'], f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}',
     {'kind': 16, 'header': {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2}, 'payload': ascii_hex('hi')}),
    ('a result', ['6.1'], 'A1 11 00 02  00 00 00 03 | 01 02',
     {'kind': 17, 'header': {'callId': 3, 'kind': 17}, 'payload': '01 02'}),
    ('a notification with no payload', ['6.1'], 'A1 13 00 02  00 00 00 0D',
     {'kind': 19, 'header': {'callId': 13, 'kind': 19}, 'payload': ''}),
    ('a cancel, nothing after its header', ['6.4'], 'A1 16 00 02  00 00 00 05',
     {'kind': 22, 'header': {'callId': 5, 'kind': 22}}),
    ('a protocol failure, its record after the header', ['6.2', '7.1'],
     f'A1 12 00 02  00 00 00 03 | 00 13 00 00  {ascii_hex("no procedure 1 in service 2")}',
     {'kind': 18, 'header': {'callId': 3, 'kind': 18},
      'failure': {'code': 19, 'detail': 'no procedure 1 in service 2', 'relays': 0, 'scope': 0}}),
    ('an application failure', ['6.2', '7.2'], f'A1 12 00 02  00 00 00 03 | 00 15 00 01  {ascii_hex("out of range")}',
     {'kind': 18, 'header': {'callId': 3, 'kind': 18},
      'failure': {'code': 21, 'detail': 'out of range', 'relays': 0, 'scope': 1}}),
    ('the smallest failure, 12 bytes', ['6.2', '7.1'], 'A1 12 00 02  00 00 00 03 | 00 13 00 00',
     {'kind': 18, 'header': {'callId': 3, 'kind': 18}, 'failure': {'code': 19, 'detail': '', 'relays': 0, 'scope': 0}}),
    ('a request opening a transfer, its payload the first bytes', ['4.6', '6.1'],
     'A1 10 04 05  00 00 00 03  00 02 00 01  00 00 00 00 02 80 00 00 | 01',
     {'kind': 16, 'header': {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2, 'total': 41943040}, 'payload': '01'}),
    ('a result opening a transfer of nothing', ['4.6', '6.1'], 'A1 11 04 04  00 00 00 02  00 00 00 00 00 00 00 00',
     {'kind': 17, 'header': {'callId': 2, 'kind': 17, 'total': 0}, 'payload': ''}),
    ('a request presenting a JWT, its payload after the padding', ['4.4.3', '6.1'],
     f'A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  61  00 00 00 | {ascii_hex("hi")}',
     {'kind': 16, 'header': {'callId': 3, 'credential': {'scheme': 'JWT', 'token': 'a'}, 'kind': 16, 'procedureId': 1, 'serviceId': 2},
      'payload': ascii_hex('hi')}),
    ('a failure announcing that its session ended, its record after the block', ['4.4.1', '6.2'],
     f'A1 12 08 03  00 00 00 03  00 00 00 00 | 00 20 00 00  {ascii_hex("no session")}',
     {'kind': 18, 'header': {'callId': 3, 'credential': ENDED, 'kind': 18},
      'failure': {'code': 32, 'detail': 'no session', 'relays': 0, 'scope': 0}}),
    ('a chunk with more to come', ['4.9', '6.3'], 'A1 14 40 04  00 00 00 07  00 00 00 00 00 00 00 05 | 01 02 03',
     {'kind': 20, 'header': {'callId': 7, 'isLast': False, 'kind': 20, 'offset': 5}, 'payload': '01 02 03'}),
    ('a credit, nothing after its header', ['6.4'], 'A1 15 00 04  00 00 00 07  00 00 00 00 00 00 00 0A',
     {'kind': 21, 'header': {'callId': 7, 'creditEnd': 10, 'kind': 21}}),
]

envelope_refusals = [
    ('a cancel with a byte after its header', ['6.4'], 'A1 16 00 02  00 00 00 05 | 00', None, MALFORMED, 'a cancel carries no payload, not 1 bytes'),
    ('a chunk without a byte', ['6.3'], 'A1 14 00 04  00 00 00 07  00 00 00 00 00 00 00 00', None, MALFORMED, 'a chunk carries one byte at least'),
    ('a credit with a byte after its header', ['6.4'], 'A1 15 00 04  00 00 00 07  00 00 00 00 00 00 00 08 | 01', None, MALFORMED,
     'a credit carries no payload, not 1 bytes'),
    # the bound on a whole envelope, checked once its first byte says it is one, before its layout
    ('an envelope past its bound', ['5.1.2', '12.2.1'], f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13, ENVELOPE_TOO_LARGE,
     'an envelope is 13 bytes at most, not 14'),
    ('a layout to come past the bound, its length checked first', ['5.1.2'], f'A2 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13,
     ENVELOPE_TOO_LARGE, None),
    ('7 bytes past a bound of 4, short of a prefix first', ['5.1.1'], 'A1 10 00 03  00 00 00', 4, MALFORMED, None),
    ('a first byte no layout is, past the bound', ['5.1.1'], f'B0 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13, MALFORMED, None),
]

failures = [
    ('the relays as they came, and no detail as empty', ['7.1', '7.5'], '00 12 03 00', None, {'code': 18, 'detail': '', 'relays': 3, 'scope': 0}),
    ('the last code, of the application', ['7.2'], 'FF FF 00 01', None, {'code': 65535, 'detail': '', 'relays': 0, 'scope': 1}),
    ('a detail cut at 5 bytes, back to the start of the character cut', ['7.3'], f'00 13 00 00  {ascii_hex("abcdéf")}', 5,
     {'code': 19, 'detail': 'abcd', 'relays': 0, 'scope': 0}),
    ('a detail cut at 3 bytes, on a character boundary', ['7.3'], f'00 13 00 00  {ascii_hex("abcdéf")}', 3,
     {'code': 19, 'detail': 'abc', 'relays': 0, 'scope': 0}),
    ('a leading U+FEFF kept', ['7.3'], '00 13 00 00  EF BB BF 61', None, {'code': 19, 'detail': '\ufeffa', 'relays': 0, 'scope': 0}),
    ('a byte that is not UTF-8, read as U+FFFD', ['7.3'], '00 13 00 00  61 FF', None, {'code': 19, 'detail': 'a\ufffd', 'relays': 0, 'scope': 0}),
    # the maximal subparts of the WHATWG decoder: one U+FFFD for each run that could have begun a character
    ('a detail ending inside a character, one U+FFFD', ['7.3'], '00 13 00 00  61 E2 82', None,
     {'code': 19, 'detail': 'a\ufffd', 'relays': 0, 'scope': 0}),
    ('a character cut short by another, one U+FFFD before it', ['7.3'], '00 13 00 00  F0 9F 98 41', None,
     {'code': 19, 'detail': '\ufffdA', 'relays': 0, 'scope': 0}),
    ('a surrogate spelled in UTF-8, one U+FFFD a byte', ['7.3'], '00 13 00 00  ED A0 80', None,
     {'code': 19, 'detail': '\ufffd\ufffd\ufffd', 'relays': 0, 'scope': 0}),
]

failure_refusals = [
    ('no byte at all', ['7.1'], ''),
    ('3 bytes, fewer than a record', ['7.1'], '00 13 00'),
    ('a code of 0', ['7.2'], '00 00 00 00'),
    ('the flag 0x02', ['7.2'], '00 13 00 02'),
    ('the flag 0x04', ['7.2'], '00 13 00 04'),
    ('the flag 0x80', ['7.2'], '00 13 00 80'),
    ('the flags 0x03', ['7.2'], '00 13 00 03'),
]


def entry(**fields):
    return {key: value for key, value in fields.items() if value is not None}


document = {
    '$schema': 'schemas/vectors.schema.json',
    '$comment': [
        "Bead's conformance vectors: the bytes of envelopes and what they say, written once and read by every implementation's tests.",
        'Bytes are hexadecimal, spaces aside; a bar parts a header from what follows it.',
        "A header is the fields an envelope's header carries. credential is its CREDENTIAL block: its scheme, NONE, OPAQUE, JWT or ELSEWHERE by name, a scheme to come by its number; OPAQUE's bytes and a scheme to come's in bytes, in hexadecimal, a JWT's in token, a character a byte.",
        'kind: REQUEST 16, RESULT 17, FAILURE 18, NOTIFICATION 19, CHUNK 20, CREDIT 21, CANCEL 22. scope: PROTOCOL 0, APPLICATION 1.',
        "A refusal names the protocol code a reader answers with; its detail, where given, is what the TypeScript implementation says, and is informative: an implementation compares the code.",
        "maximumEnvelopeBytes and maximumDetailBytes, where given, are the reader's bounds; where not, the vector is within any bound.",
        "side is the side that reads: a failure says which side raised it.",
        'clauses are the units of spec.md an entry checks: a clause, 9.2; an item of its numbered list, 9.2.5; a row of its table, counted from 1, 15.6.8.',
    ],
    'specVersion': spec_version(),
    'headers': [entry(name=name, clauses=clauses, bytes=data, header=header) for name, clauses, data, header in headers],
    'reads': [{'name': name, 'clauses': clauses, 'side': side, 'bytes': data, 'header': header}
              for name, clauses, side, data, header in reads],
    'prefixes': [entry(name=name, clauses=clauses, bytes=data, prefix=prefix) for name, clauses, data, prefix in prefixes],
    'prefixRefusals': [entry(name=name, clauses=clauses, bytes=data, code=MALFORMED) for name, clauses, data in prefix_refusals],
    'headerRefusals': [entry(name=name, clauses=clauses, bytes=data, code=code, detail=detail)
                       for name, clauses, data, code, detail in header_refusals],
    'envelopes': [entry(name=name, clauses=clauses, bytes=data, envelope=envelope) for name, clauses, data, envelope in envelopes],
    'envelopeRefusals': [entry(name=name, clauses=clauses, bytes=data, maximumEnvelopeBytes=maximum, code=code, detail=detail)
                         for name, clauses, data, maximum, code, detail in envelope_refusals],
    'failures': [entry(name=name, clauses=clauses, record=record, maximumDetailBytes=maximum, failure=failure)
                 for name, clauses, record, maximum, failure in failures],
    'failureRefusals': [entry(name=name, clauses=clauses, record=record, code=MALFORMED) for name, clauses, record in failure_refusals],
}

with open(OUT, 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print({key: len(value) for key, value in document.items() if isinstance(value, list) and key != '$comment'})
