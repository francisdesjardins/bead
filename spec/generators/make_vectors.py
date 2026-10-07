"""Writes spec/vectors.json: Bead's conformance vectors, the one source every implementation's tests read."""
import base64
import datetime
import hashlib
import hmac
import json
import math
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
    # the cut steps back over one character at most, to a lead byte three bytes back at most whose
    # sequence crosses it; a cut that falls on a stray continuation byte stays where it fell
    ('a stray continuation byte at the cut, the character before it kept whole', ['7.3'], '00 13 00 00  E2 82 AC 80 61', 3,
     {'code': 19, 'detail': '€', 'relays': 0, 'scope': 0}),
    ('continuation bytes past three before the cut, read as U+FFFD each, the cut kept', ['7.3'], '00 13 00 00  61 80 80 80 80 80', 5,
     {'code': 19, 'detail': 'a����', 'relays': 0, 'scope': 0}),
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


# ── The verdicts of JWTs (section 13.8) ─────────────────────────────────────────────────────────


def base64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def unbase64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def compact(value):
    """JSON as a token carries it: no space, its members in the order written, ASCII escaped."""
    return json.dumps(value, separators=(',', ':')).encode('ascii')


def thumbprint(jwk):
    """A JWK's thumbprint (RFC 7638): SHA-256 over its required members, in their order, no space."""
    required = ('crv', 'kty', 'x', 'y') if jwk['kty'] == 'EC' else ('k', 'kty')
    return base64url(hashlib.sha256(compact({name: jwk[name] for name in required})).digest())


# the published test keys, their public halves alone, but the HMAC key's: RFC 7515's A.1 and A.3, and
# RFC 7517's A.1, a key set's encryption key; spec/check.py keeps them out of every file but spec/'s,
# the tests' and the interop service's
HMAC_KEY = {'kty': 'oct', 'k': 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow'}
EC_KEY = {'kty': 'EC', 'crv': 'P-256', 'x': 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
          'y': 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0'}
ENCRYPTION_KEY = {'kty': 'EC', 'crv': 'P-256', 'x': 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
                  'y': '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM', 'use': 'enc', 'kid': '1'}

# the EC key's public bytes as a library takes them: SubjectPublicKeyInfo's DER (RFC 5480), whose head
# names P-256, then the point uncompressed; its PEM (RFC 7468); its JWK's JSON
EC_DER = (bytes.fromhex('3059301306072a8648ce3d020106082a8648ce3d030107034200') + b'\x04'
          + unbase64url(EC_KEY['x']) + unbase64url(EC_KEY['y']))
EC_PEM = ('-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(EC_DER).decode('ascii')
          + '\n-----END PUBLIC KEY-----\n').encode('ascii')
EC_JSON = compact(EC_KEY)

ISSUER, TRUST, OTHER = 'https://issuer.example', 'https://trust.example', 'https://other.example'
AUDIENCE = 'https://bead.example'

# 2026-10-03T12:00:00Z, and an hour later
IAT = 1791028800
EXP = IAT + 3600

LEEWAY = 60_000
LARGEST = 2 ** 53 - 1

# the ES256 tokens are constants, by choice: signed once under RFC 7515's A.3 key, the EC key, or RFC
# 7517's encryption key, each verified by both platforms before it was written here, which RFC 6979's
# deterministic ECDSA would also let this generator sign itself; and an RS256 one, under RFC 7515's
# A.2 key. Their claims: an ID token's (OpenID Connect Core 1.0 §2), or an access token's (RFC 9068
# §2.2), from ISSUER, for AUDIENCE, issued at IAT and expiring at EXP
ES256_ID_TOKEN = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3ViIjoiYWxpY2UiLCJhdWQiOiJodHRwczovL2JlYWQ'
    'uZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMDI4ODAwLCJhdXRoX3RpbWUiOjE3OTEwMjg3NDAsIm5vbmNlIjoibi0wUzZfV3pBMk1qIn0.'
    'afdHHFBG13xzIyaj7YYD8hRyhoiOC5dYkgTJmuEGGgiNBiXgVoNSKtF0kH4PSrFUQGf9m31rY0yO-1IhmwXWDA')
ES256_ID_TOKEN_TWIN = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3ViIjoiYWxpY2UiLCJhdWQiOiJodHRwczovL2J'
    'lYWQuZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMDI4ODAwLCJhdXRoX3RpbWUiOjE3OTEwMjg3NDAsIm5vbmNlIjoibi0wUzZfV3pBMk1qIn0.'
    'EnvKoA_KfmlqnXT-sR3E-WbhRWZ_JIOLD5fsQNz1DOjjsrjezokrClVqBoqytK0Rjcg68wvAFG3tKvI-KEyybw')
ES256_BY_THUMBPRINT = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6Im9LSXl3dkdVcFRWVHl4TVEzYndJSWVRVXVkZnJfQ2tMTWpDRTE5RUNELVUifQ.eyJpc3MiOiJod'
    'HRwczovL2lzc3Vlci5leGFtcGxlIiwic3ViIjoiYWxpY2UiLCJhdWQiOiJodHRwczovL2JlYWQuZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMD'
    'I4ODAwLCJqdGkiOiJhdC0wMDAxIiwiY2xpZW50X2lkIjoiYmVhZC1jbGllbnQifQ.'
    'WiY3sfvUEgIK1ZLd-SQn5jTcqNyDDNFSDihxQnJtkt7GslcL3JPGN05kUz-mmcvDhj1yfBVmCd5ZoBSbS3Bliw')
ES256_OWN_JWK = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImp3ayI6eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6Ik1LQkNUTkljS1VTRGlpMTF5U3MzNTI2aURa'
    'OEFpVG83VHU2S1BBcXY3RDQiLCJ5IjoiNEV0bDZTUlcyWWlMVXJONXZmdlZIdWhwN3g4UHhsdG1XV2xiYk00SUZ5TSJ9fQ.eyJpc3MiOiJodHRwczovL2lzc3Vlc'
    'i5leGFtcGxlIiwic3ViIjoiYWxpY2UiLCJhdWQiOiJodHRwczovL2JlYWQuZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMDI4ODAwLCJqdGkiOi'
    'JhdC0wMDAxIiwiY2xpZW50X2lkIjoiYmVhZC1jbGllbnQifQ.'
    'cRVKc-oghK1S2kelPyrGpIOweCc8_FfZU2o79-fgbJIYlVqp-wZvevmBj2yPEWDLYbhPFcgZ7RHk-hgBrznv2w')
ES256_UNDER_ENCRYPTION_KEY = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6IjEifQ.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3ViIjoiYWxpY2UiLCJhdWQiOi'
    'JodHRwczovL2JlYWQuZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMDI4ODAwLCJqdGkiOiJhdC0wMDAxIiwiY2xpZW50X2lkIjoiYmVhZC1jbGll'
    'bnQifQ.hq3cHkJJ-joFclVGnVCxbJCqzlW9eg8TuU6voNQnWI_2Rb0bfuYVMFjz9FVSZZ-BGTz-MPYA1247frXhTwrjIQ')
ES256_UNNAMED_KID = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6IjIwMjYtMTAifQ.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3ViIjoiYWxpY2UiLC'
    'JhdWQiOiJodHRwczovL2JlYWQuZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMDI4ODAwLCJqdGkiOiJhdC0wMDAxIiwiY2xpZW50X2lkIjoiYmVh'
    'ZC1jbGllbnQifQ.FRMoxYau2SZ6eYewa4qhAoI1bLnoXuDDlbAWFvg11jFxoiu23ff1agki1OkJzOAntiXBmI2LpFA4CxRbLiiv-g')
RS256_TOKEN = (
    'eyJhbGciOiJSUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJpc3MiOiJodHRwczovL2lzc3Vlci5leGFtcGxlIiwic3ViIjoiYWxpY2UiLCJhdWQiOiJodHRwczovL2J'
    'lYWQuZXhhbXBsZSIsImV4cCI6MTc5MTAzMjQwMCwiaWF0IjoxNzkxMDI4ODAwLCJqdGkiOiJhdC0wMDAxIiwiY2xpZW50X2lkIjoiYmVhZC1jbGllbnQifQ.'
    'BdUqfQft_6sxQFjVnnTMpSC41R61RM90O2KtrtRfZiD_DKySmzsYRvN70gCzsykaWJkxVzybNFn6LPmxXd6VR_LG-uFH7-Lr7VWhylDBgpxMzAQBBwn01WpqL_bb9'
    'SDEOfuIlE0Dy94Kcgb6MfxJ-BDghGtaN5Qsp2uLd3dp_V1jpMkcF9f-OlO2aTD4x0wQ4vVmiA7bvVG8Q5ltmi3zDjMCWLGoR6cul2q-aJyKsGm6gyV1L-pPZteC'
    'Wq47cdr7EpBCllLeh0abrhCd12yawTpflkj-u4JzDcZ127BATNOZZZwEFZ7wdjYKtnJYF_-sKydyNFqJTWumdJ3O5j8xAg')

# the steps of section 13.8, each an item of its list, in their order
TOKEN, CRIT, TYP, KID, ALG, KEY, SIGNATURE, ISS, EXP_STEP, NBF, AUD, SID, SUB = range(1, 14)
REASONS = {TOKEN: 'token', CRIT: 'crit', TYP: 'typ', KID: 'kid', ALG: 'alg', KEY: 'key', SIGNATURE: 'signature',
           ISS: 'iss', EXP_STEP: 'exp', NBF: 'nbf', AUD: 'aud', SID: 'sid', SUB: 'sub'}


def instant(milliseconds):
    """The wall clock's reading as an RFC 3339 instant, to the millisecond, in UTC."""
    seconds, fraction = divmod(milliseconds, 1000)
    moment = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return moment.strftime('%Y-%m-%dT%H:%M:%S') + f'.{fraction:03d}Z'


NOW = IAT * 1000 + 60_000


def key(issuer, algorithm, jwk):
    return {'issuer': issuer, 'algorithm': algorithm, 'jwk': jwk}


ES = key(ISSUER, 'ES256', EC_KEY)
ES_BY_THUMBPRINT = key(ISSUER, 'ES256', {**EC_KEY, 'kid': thumbprint(EC_KEY)})
HS = key(TRUST, 'HS256', HMAC_KEY)
HS_BY_THUMBPRINT = key(TRUST, 'HS256', {**HMAC_KEY, 'kid': thumbprint(HMAC_KEY)})


def part(value):
    """A header or a claims set, from a JSON value or from its bytes as given."""
    return base64url(value if isinstance(value, bytes) else compact(value))


def hs256(header, claims, secret=unbase64url(HMAC_KEY['k'])):
    """A JWS signed with HMAC-SHA256 (RFC 7518 §3.2), with Python's own hmac."""
    signing_input = part(header) + '.' + part(claims)
    return signing_input + '.' + base64url(hmac.new(secret, signing_input.encode('ascii'), hashlib.sha256).digest())


def access(issuer=TRUST, **claims):
    """An access token's claims (RFC 9068 §2.2), changed or, by None, left out."""
    written = {'iss': issuer, 'sub': 'bob', 'aud': AUDIENCE, 'exp': EXP, 'iat': IAT, 'jti': 'at-0002', 'client_id': 'bead-client'}
    written.update(claims)
    return {name: value for name, value in written.items() if value is not None}


AT_JWT = {'alg': 'HS256', 'typ': 'at+jwt'}


def with_signature(token, signature):
    return token.rsplit('.', 1)[0] + '.' + base64url(signature)


def flipped(token):
    """The token with its signature's first byte changed."""
    signature = bytearray(unbase64url(token.rsplit('.', 1)[1]))
    signature[0] ^= 0x01
    return with_signature(token, bytes(signature))


def der_of(token):
    """The token with its ES256 signature, R then S, written as DER's ECDSA-Sig-Value (RFC 3279)."""
    signature = unbase64url(token.rsplit('.', 1)[1])

    def integer(value):
        value = value.lstrip(b'\x00') or b'\x00'
        value = b'\x00' + value if value[0] & 0x80 else value
        return b'\x02' + bytes([len(value)]) + value

    body = integer(signature[:32]) + integer(signature[32:])
    return with_signature(token, b'\x30' + bytes([len(body)]) + body)


def past_its_bytes(token):
    """The token with a bit set past its signature's last byte, in its last character's unused bits."""
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    last = alphabet.index(token[-1])
    assert last & 1 == 0, 'a last character whose unused bits are zero'
    return token[:-1] + alphabet[last | 1]


def holds(token, issuer, end, **named):
    """A verdict that holds: its session's identifier, its claims set as the token carries it, its end."""
    claims = json.loads(unbase64url(token.split('.')[1]))
    return {'holds': True, 'identifier': {'issuer': issuer, **named}, 'claims': claims, 'end': end}


def refused(step):
    return {'holds': False, 'reason': REASONS[step]}


# the fraction of exp that a floor would lose: the token holds a millisecond past what floor allows
FRACTIONAL_EXP = EXP + 0.0005
assert math.floor(FRACTIONAL_EXP * 1000) == EXP * 1000 and math.ceil(FRACTIONAL_EXP * 1000) == EXP * 1000 + 1

# the last whole second of exp whose end is 2^53 - 1 at most, and the one after it
LAST_EXP = (LARGEST - LEEWAY) // 1000
assert LAST_EXP * 1000 + LEEWAY <= LARGEST < (LAST_EXP + 1) * 1000 + LEEWAY

TWIN_END = EXP * 1000 + LEEWAY
HS_TOKEN = hs256(AT_JWT, access())

jwt_verdicts = [
    # typ: an ID token of the same issuer, under the same key, refused; its twin taken
    ('an ID token, typed JWT by its issuer', [TYP], ES256_ID_TOKEN, [ES], NOW, refused(TYP)),
    ('its twin, typed at+jwt', ['13.8', TYP], ES256_ID_TOKEN_TWIN, [ES], NOW,
     holds(ES256_ID_TOKEN_TWIN, ISSUER, TWIN_END, sub='alice')),
    ('typed application/at+jwt, its media type written whole', [TYP], hs256({**AT_JWT, 'typ': 'application/at+jwt'}, access()), [HS],
     NOW, holds(hs256({**AT_JWT, 'typ': 'application/at+jwt'}, access()), TRUST, TWIN_END, sub='bob')),
    ('typed AT+JWT, a value RFC 9068 does not name', [TYP], hs256({**AT_JWT, 'typ': 'AT+JWT'}, access()), [HS], NOW, refused(TYP)),
    ('with no typ', [TYP], hs256({'alg': 'HS256'}, access()), [HS], NOW, refused(TYP)),
    # the key: found by kid among the keys alone, never by what the token carries
    ('an ES256 token found by its kid, its key\'s thumbprint', ['13.8', KID], ES256_BY_THUMBPRINT, [HS, ES_BY_THUMBPRINT], NOW,
     holds(ES256_BY_THUMBPRINT, ISSUER, TWIN_END, sub='alice')),
    ('an HS256 token found by its kid, among two issuers\' keys', ['13.8', KID],
     hs256({**AT_JWT, 'kid': thumbprint(HMAC_KEY)}, access()), [ES, HS_BY_THUMBPRINT], NOW,
     holds(hs256({**AT_JWT, 'kid': thumbprint(HMAC_KEY)}, access()), TRUST, TWIN_END, sub='bob')),
    ('two issuers\' keys under one kid, the token\'s issuer\'s taken', [KID], hs256({**AT_JWT, 'kid': 'k1'}, access()),
     [key(ISSUER, 'ES256', {**EC_KEY, 'kid': 'k1'}), key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1'})], NOW,
     holds(hs256({**AT_JWT, 'kid': 'k1'}, access()), TRUST, TWIN_END, sub='bob')),
    ('a kid that names no key, while the issuer\'s one key would verify', [KID], ES256_UNNAMED_KID, [ES], NOW, refused(KID)),
    ('a token without a kid, whose issuer has two keys', [KID], HS_TOKEN, [HS, HS_BY_THUMBPRINT], NOW, refused(KID)),
    ('a token carrying its own key in jwk, which is never read', [CRIT, SIGNATURE], ES256_OWN_JWK, [ES], NOW, refused(SIGNATURE)),
    ('a token with crit', [CRIT], hs256({**AT_JWT, 'crit': ['urn:example:bound'], 'urn:example:bound': True}, access()), [HS], NOW,
     refused(CRIT)),
    # alg: its key's, whatever the token says
    ('an ES256 token met by an HS256 key', [ALG], ES256_ID_TOKEN_TWIN, [key(ISSUER, 'HS256', HMAC_KEY)], NOW, refused(ALG)),
    ('an HS256 token met by an ES256 key', [ALG], hs256(AT_JWT, access(ISSUER)), [ES], NOW, refused(ALG)),
    ('an HS256 token keyed with an ES256 key\'s public bytes, its PEM', [ALG], hs256(AT_JWT, access(ISSUER), EC_PEM), [ES], NOW,
     refused(ALG)),
    ('an HS256 token keyed with an ES256 key\'s public bytes, its DER', [ALG], hs256(AT_JWT, access(ISSUER), EC_DER), [ES], NOW,
     refused(ALG)),
    ('an HS256 token keyed with an ES256 key\'s public bytes, its JWK\'s JSON', [ALG], hs256(AT_JWT, access(ISSUER), EC_JSON), [ES], NOW,
     refused(ALG)),
    ('an RS256 token', [ALG], RS256_TOKEN, [ES], NOW, refused(ALG)),
    ('alg none, with no signature', [ALG], part({'alg': 'none', 'typ': 'at+jwt'}) + '.' + part(access()) + '.', [HS], NOW, refused(ALG)),
    # the key serves by its JWK's alg, use and key_ops
    ('a key whose JWK names its algorithm, its use and its key_ops', ['13.8', KEY], HS_TOKEN,
     [key(TRUST, 'HS256', {**HMAC_KEY, 'alg': 'HS256', 'use': 'sig', 'key_ops': ['verify']})], NOW,
     holds(HS_TOKEN, TRUST, TWIN_END, sub='bob')),
    ('a token under a key set\'s encryption key', [KEY], ES256_UNDER_ENCRYPTION_KEY, [key(ISSUER, 'ES256', ENCRYPTION_KEY)], NOW,
     refused(KEY)),
    ('a key whose key_ops leave verify out', [KEY], HS_TOKEN, [key(TRUST, 'HS256', {**HMAC_KEY, 'key_ops': ['sign']})], NOW,
     refused(KEY)),
    ('a key whose JWK names another algorithm', [KEY], HS_TOKEN, [key(TRUST, 'HS256', {**HMAC_KEY, 'alg': 'HS512'})], NOW, refused(KEY)),
    # the signature, over the token's first two parts as they came
    ('an ES256 signature with a byte changed', [SIGNATURE], flipped(ES256_ID_TOKEN_TWIN), [ES], NOW, refused(SIGNATURE)),
    ('an ES256 signature written in DER, never converted', [SIGNATURE], der_of(ES256_ID_TOKEN_TWIN), [ES], NOW, refused(SIGNATURE)),
    ('an HS256 signature with a byte changed', [SIGNATURE], flipped(HS_TOKEN), [HS], NOW, refused(SIGNATURE)),
    # iss: its key's issuer, octet for octet
    ('the right key and audience under a foreign iss', [ISS], hs256({**AT_JWT, 'kid': thumbprint(HMAC_KEY)}, access(ISSUER)),
     [ES, HS_BY_THUMBPRINT], NOW, refused(ISS)),
    ('no iss, its key found by its kid', [ISS], hs256({**AT_JWT, 'kid': thumbprint(HMAC_KEY)}, access(None)), [HS_BY_THUMBPRINT], NOW,
     refused(ISS)),
    # exp and nbf, each a millisecond either side of its leeway
    ('exp plus 60,000 less 1, the last millisecond it holds', ['13.8', EXP_STEP], HS_TOKEN, [HS], EXP * 1000 + LEEWAY - 1,
     holds(HS_TOKEN, TRUST, TWIN_END, sub='bob')),
    ('exp plus 60,000, the first millisecond it does not hold', [EXP_STEP], HS_TOKEN, [HS], EXP * 1000 + LEEWAY, refused(EXP_STEP)),
    ('nbf less 60,000, the first millisecond it holds', ['13.8', NBF], hs256(AT_JWT, access(nbf=IAT)), [HS], IAT * 1000 - LEEWAY,
     holds(hs256(AT_JWT, access(nbf=IAT)), TRUST, TWIN_END, sub='bob')),
    ('nbf less 60,001, the last millisecond it does not hold', [NBF], hs256(AT_JWT, access(nbf=IAT)), [HS], IAT * 1000 - LEEWAY - 1,
     refused(NBF)),
    ('a fraction of exp, rounded up to its millisecond', ['13.8', EXP_STEP], hs256(AT_JWT, access(exp=FRACTIONAL_EXP)), [HS],
     EXP * 1000 + LEEWAY, holds(hs256(AT_JWT, access(exp=FRACTIONAL_EXP)), TRUST, EXP * 1000 + 1 + LEEWAY, sub='bob')),
    ('no exp', [EXP_STEP], hs256(AT_JWT, access(exp=None)), [HS], NOW, refused(EXP_STEP)),
    ('exp a string', [EXP_STEP], hs256(AT_JWT, access(exp=str(EXP))), [HS], NOW, refused(EXP_STEP)),
    ('an exp whose end is 2^53 - 1 at most', ['13.8', EXP_STEP], hs256(AT_JWT, access(exp=LAST_EXP)), [HS], NOW,
     holds(hs256(AT_JWT, access(exp=LAST_EXP)), TRUST, LAST_EXP * 1000 + LEEWAY, sub='bob')),
    ('an exp a second later, whose end passes 2^53 - 1', [EXP_STEP], hs256(AT_JWT, access(exp=LAST_EXP + 1)), [HS], NOW,
     refused(EXP_STEP)),
    ('nbf a string', [NBF], hs256(AT_JWT, access(nbf=str(IAT))), [HS], NOW, refused(NBF)),
    ('an nbf whose milliseconds pass -(2^53 - 1)', [NBF], hs256(AT_JWT, access(nbf=-(LARGEST // 1000 + 1))), [HS], NOW, refused(NBF)),
    # aud: a string, or an array of strings, that names the audience
    ('aud an array naming the audience among others', ['13.8', AUD], hs256(AT_JWT, access(aud=[OTHER, AUDIENCE])), [HS], NOW,
     holds(hs256(AT_JWT, access(aud=[OTHER, AUDIENCE])), TRUST, TWIN_END, sub='bob')),
    ('aud naming another audience', [AUD], hs256(AT_JWT, access(aud=OTHER)), [HS], NOW, refused(AUD)),
    ('no aud', [AUD], hs256(AT_JWT, access(aud=None)), [HS], NOW, refused(AUD)),
    ('aud an array holding a number beside the audience', [AUD], hs256(AT_JWT, access(aud=[AUDIENCE, 7])), [HS], NOW, refused(AUD)),
    # the session's identifier: iss with sid, else with sub
    ('sid against sub, named by sid', ['13.8', SID], hs256(AT_JWT, access(sid='s-2026')), [HS], NOW,
     holds(hs256(AT_JWT, access(sid='s-2026')), TRUST, TWIN_END, sid='s-2026')),
    ('sub alone, named by sub', ['13.8', SUB], HS_TOKEN, [HS], NOW, holds(HS_TOKEN, TRUST, TWIN_END, sub='bob')),
    ('sid a number', [SID], hs256(AT_JWT, access(sid=7)), [HS], NOW, refused(SID)),
    ('neither sid nor sub', [SUB], hs256(AT_JWT, access(sub=None)), [HS], NOW, refused(SUB)),
    ('a sub holding a lone surrogate, which names nothing', [SUB], hs256(AT_JWT, access(sub='\ud800')), [HS], NOW, refused(SUB)),
    # the token's form: three parts of base64url, a header and a claims set each a JSON object
    ('a token of two parts', [TOKEN], HS_TOKEN.rsplit('.', 1)[0], [HS], NOW, refused(TOKEN)),
    ('a signature padded as base64 is', [TOKEN], HS_TOKEN + '=', [HS], NOW, refused(TOKEN)),
    ('a signature whose last character sets a bit past its bytes', [TOKEN], past_its_bytes(HS_TOKEN), [HS], NOW, refused(TOKEN)),
    ('a header opening with a byte order mark', [TOKEN], hs256(b'\xef\xbb\xbf' + compact(AT_JWT), access()), [HS], NOW,
     refused(TOKEN)),
    ('a claims set holding a byte that is not UTF-8', [TOKEN], hs256(AT_JWT, compact(access(jti='at-\xff')).replace(b'\\u00ff', b'\xff')),
     [HS], NOW, refused(TOKEN)),
    ('a claims set that is an array', [TOKEN], hs256(AT_JWT, [access()]), [HS], NOW, refused(TOKEN)),
    ('a claims set naming aud twice', [TOKEN],
     hs256(AT_JWT, compact(access(aud=OTHER))[:-1] + b',"aud":' + compact(AUDIENCE) + b'}'), [HS], NOW, refused(TOKEN)),
    ('a header naming alg twice, once escaped', [TOKEN], hs256(b'{"alg":"none","typ":"at+jwt","\\u0061lg":"HS256"}', access()), [HS],
     NOW, refused(TOKEN)),
    ('a claims set naming a member by a lone surrogate', [TOKEN], hs256(AT_JWT, access(**{'\udc00': 1})), [HS], NOW, refused(TOKEN)),
]

# aud against a set of audiences, as a relay that verifies holds those its destinations were
# registered with (section 14.3): the token names one of them, or none
AUDIENCES = [AUDIENCE, OTHER]
THIRD = 'https://third.example'

jwt_verdicts_against_a_set = [
    ('aud an array naming one of a set of audiences', ['13.8', AUD], hs256(AT_JWT, access(aud=[THIRD, OTHER])), [HS], NOW,
     holds(hs256(AT_JWT, access(aud=[THIRD, OTHER])), TRUST, TWIN_END, sub='bob')),
    ('aud naming none of a set of audiences', [AUD], hs256(AT_JWT, access(aud=THIRD)), [HS], NOW, refused(AUD)),
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
        "A JWT verdict gives a token, the keys, each a JWK with its issuer and its algorithm, the receiver's audience, or the set of them a relay that verifies holds, an array, any of which aud may name, and now, the wall clock's reading, which a test gives as W; then whether the token holds, with its session's identifier, its claims set and its end, in milliseconds since the epoch, or why it does not: the step of section 13.8 that refused it.",
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
    'jwtVerdicts': [{'name': name, 'clauses': [unit if isinstance(unit, str) else f'13.8.{unit}' for unit in units], 'token': token,
                     'keys': keys, 'audience': audience, 'now': instant(now), 'verdict': verdict}
                    for audience, verdicts in ((AUDIENCE, jwt_verdicts), (AUDIENCES, jwt_verdicts_against_a_set))
                    for name, units, token, keys, now, verdict in verdicts],
}

with open(OUT, 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print({key: len(value) for key, value in document.items() if isinstance(value, list) and key != '$comment'})
