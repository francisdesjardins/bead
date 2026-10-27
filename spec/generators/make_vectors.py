"""Writes spec/vectors.json: Bead's conformance vectors, the one source every implementation's tests read."""
import base64
import datetime
import hashlib
import hmac
import json
import math
import os
import re
import string

from mqtt_packets import (LARGEST_PACKET, MAXIMUM_PACKET_SIZE, largest_payload, publish_bytes, remaining_length,
                          width)
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
    ('the last advisory kind, skipped whatever follows', ['3.4', '5.1', '5.1.4'], 'server', 'A1 FF FF FF  00 00 00 00', None),
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
    # the order a reader checks in: the layout, then the kind, then the call id; a vector that fails two
    # checks, refused by the first, cites 5.1 itself, which states that order
    ('a layout to come, before a kind that is never one and a call id of 0', ['2.3', '5.1', '5.1.3'], 'A2 00 00 02  00 00 00 00', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a layout to come, before an advisory kind', ['2.3', '5.1', '5.1.3'], 'A2 80 00 02  00 00 00 03', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a kind to come, before a call id of 0', ['3.3', '5.1', '5.1.6'], 'A1 17 00 02  00 00 00 00', KIND_UNSUPPORTED, None),
    ('a kind of 0x00, never one', ['3.2', '5.1.5'], 'A1 00 00 02  00 00 00 03', MALFORMED, None),
    ('a kind of 0x0F, never one', ['3.2', '5.1.5'], 'A1 0F 00 02  00 00 00 03', MALFORMED, None),
    ('a kind to come, 0x17', ['3.3', '5.1.6'], 'A1 17 00 02  00 00 00 03', KIND_UNSUPPORTED, None),
    ('a kind to come, 0x7F', ['3.3', '5.1.6'], 'A1 7F 00 02  00 00 00 03', KIND_UNSUPPORTED, None),
    ('a call id of 0', ['3.5', '5.1.7'], 'A1 11 00 02  00 00 00 00', MALFORMED, None),
    # a kept bit, which 4.2 refuses on every kind, kept bits included
    ('the kept bit 0x01 on a request, 16 bytes after its procedure', ['4.1', '4.2', '4.2.1'], f'A1 10 01 07  00 00 00 03  00 02 00 01  {TOKEN_BYTES}',
     MALFORMED, 'a 0x10 envelope carries no flag 0x01'),
    ('the kept bit 0x01 on a result, 16 bytes after its prefix', ['4.1', '4.2', '4.2.2'], f'A1 11 01 06  00 00 00 03  {TOKEN_BYTES}',
     MALFORMED, 'a 0x11 envelope carries no flag 0x01'),
    ('the kept bit 0x01 on a failure, 16 bytes after its prefix', ['4.1', '4.2', '4.2.3'], f'A1 12 01 06  00 00 00 03  {TOKEN_BYTES}',
     MALFORMED, 'a 0x12 envelope carries no flag 0x01'),
    ('the bit 0x40 on a request', ['4.2.1'], 'A1 10 40 03  00 00 00 03  00 02 00 01', MALFORMED, None),
    ('the reserved bit 0x80 on a request', ['4.1', '4.2', '4.2.1'], 'A1 10 80 03  00 00 00 03  00 02 00 01', MALFORMED, None),
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
    ('the kept bit 0x01 on a chunk', ['4.1', '4.2', '4.2.5'], 'A1 14 01 04  00 00 00 07  00 00 00 00 00 00 00 00',
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
    # the bound on a whole envelope, checked once its first byte says it is one, before its layout; a
    # vector that fails two checks cites 5.1's order
    ('an envelope past its bound', ['5.1.2', '12.2.1'], f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13, ENVELOPE_TOO_LARGE,
     'an envelope is 13 bytes at most, not 14'),
    ('a layout to come past the bound, its length checked first', ['5.1', '5.1.2'], f'A2 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13,
     ENVELOPE_TOO_LARGE, None),
    ('7 bytes past a bound of 4, short of a prefix first', ['5.1', '5.1.1'], 'A1 10 00 03  00 00 00', 4, MALFORMED, None),
    ('a first byte no layout is, past the bound', ['5.1', '5.1.1'], f'B0 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13, MALFORMED, None),
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
    # keys of one issuer and one material, by their thumbprint (RFC 7638), are one key, the first in the
    # order searched, which the key step reads alone
    ('two keys of one issuer under one kid, of one material, the first taken', ['13.8', KID],
     hs256({**AT_JWT, 'kid': 'k1'}, access()),
     [key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1'}), key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1', 'alg': 'HS256'})], NOW,
     holds(hs256({**AT_JWT, 'kid': 'k1'}, access()), TRUST, TWIN_END, sub='bob')),
    ('two keys of one issuer under one kid, of two materials', [KID], hs256({**AT_JWT, 'kid': 'k1'}, access()),
     [key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1'}), key(TRUST, 'ES256', {**EC_KEY, 'kid': 'k1'})], NOW, refused(KID)),
    ('two keys of one issuer under one kid, of one material, the first of which does not serve', ['13.8', KID, KEY],
     hs256({**AT_JWT, 'kid': 'k1'}, access()),
     [key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1', 'use': 'enc'}), key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1'})], NOW,
     refused(KEY)),
    ('two keys of one issuer under one kid, of one material, the second of which does not serve', ['13.8', KID, KEY],
     hs256({**AT_JWT, 'kid': 'k1'}, access()),
     [key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1'}), key(TRUST, 'HS256', {**HMAC_KEY, 'kid': 'k1', 'use': 'enc'})], NOW,
     holds(hs256({**AT_JWT, 'kid': 'k1'}, access()), TRUST, TWIN_END, sub='bob')),
    ('a kid that names no key, while the issuer\'s one key would verify', [KID], ES256_UNNAMED_KID, [ES], NOW, refused(KID)),
    ('a token without a kid, whose issuer has keys of two materials', [KID], HS_TOKEN, [HS, key(TRUST, 'ES256', EC_KEY)], NOW,
     refused(KID)),
    ('a token without a kid, whose issuer\'s two keys are of one material, the first taken', ['13.8', KID], HS_TOKEN,
     [HS, HS_BY_THUMBPRINT], NOW, holds(HS_TOKEN, TRUST, TWIN_END, sub='bob')),
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
    ('aud holding a lone surrogate after the audience, which names nothing', [AUD], hs256(AT_JWT, access(aud=AUDIENCE + '\ud800')),
     [HS], NOW, refused(AUD)),
    ('aud an array holding a lone surrogate beside the audience, which is no array of strings', [AUD],
     hs256(AT_JWT, access(aud=[AUDIENCE + '\ud800', AUDIENCE])), [HS], NOW, refused(AUD)),
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


# ── A credential refused, told (section 13.12) ─────────────────────────────────────────────────

SESSION_REQUIRED, CREDENTIAL_UNSUPPORTED = 32, 36

# each credential a server refuses as it resolves, but a JWT's verdicts, which jwtVerdicts give: the
# scheme it presents, the situation both sides' tests set up, the code answered, and the one word an
# access refused is told with
credential_refusals = [
    ('an OPAQUE of a session another connection holds', ['9.2.6', '13.2', '13.12'], 'OPAQUE', 'another-connections-session',
     SESSION_REQUIRED, 'session'),
    ('an OPAQUE no session holds', ['9.2.6', '13.12'], 'OPAQUE', 'no-session', SESSION_REQUIRED, 'session'),
    ('an ELSEWHERE whose transport carried nothing', ['9.2.6', '13.12', '15.1'], 'ELSEWHERE', 'nothing-carried',
     SESSION_REQUIRED, 'nothing-carried'),
    ('an ELSEWHERE its verifier makes no session of', ['13.11', '13.12'], 'ELSEWHERE', 'verifier-makes-none',
     SESSION_REQUIRED, 'verifier'),
    ('an ELSEWHERE whose end the wall clock has reached as its verifier settles', ['13.10.4', '13.11', '13.12'], 'ELSEWHERE',
     'end-come', SESSION_REQUIRED, 'end'),
    ('a credential scheme to come', ['9.2.6', '13.12'], 4, 'scheme-to-come', CREDENTIAL_UNSUPPORTED, 'scheme'),
    ('an ELSEWHERE to a server given no verifier', ['9.2.6', '13.11', '13.12'], 'ELSEWHERE', 'no-verifier',
     CREDENTIAL_UNSUPPORTED, 'scheme'),
    ('a JWT to a server given no keys', ['9.2.6', '13.12'], 'JWT', 'no-keys', CREDENTIAL_UNSUPPORTED, 'scheme'),
]


# ── A broker's parcels (section 15.17) ──────────────────────────────────────────────────────────

# a parcel's kinds, each a row of 15.17's table, and its flags
OPEN, ACCEPT, REFUSE, DATA, PING, PONG, CLOSE, RESET, GONE = range(1, 10)
ROW = {kind: f'15.17.{kind}' for kind in range(1, 10)}
MORE, CARRIES_CREDENTIAL, SECURE = 0x01, 0x02, 0x04
PARCEL_LAYOUT, LAYOUT_TO_COME = 0xB1, 0xB2

# the halves of a connection, its opener's and its acceptor's, a participant's incarnation, its id, and
# an id of 64 characters, the longest token, base64url's alphabet whole (RFC 4648 §5)
OPENER = '11 12 13 14 15 16 17 18'
ACCEPTOR = '21 22 23 24 25 26 27 28'
NO_HALF = '00 00 00 00 00 00 00 00'
INCARNATION = hexadecimal(bytes(range(0x31, 0x41)))
PARTICIPANT = 'peer'
LONGEST_ID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
assert len(LONGEST_ID) == 64

# what a DATA carries: an envelope of vectors' own, whole, or cut in two parts
CARRIED = f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}'
FIRST_PART, LAST_PART = 'A1 10 00 03  00 00 00 03', '00 02 00 01  68 69'
CREDENTIAL = 'Interop sub=ada'


def parcel_of(kind, sequence, body='', *, flags=0, opener=OPENER, acceptor=ACCEPTOR, layout=PARCEL_LAYOUT, kept=0):
    """A parcel's bytes: its 28 bytes of prefix, a bar, then its body."""
    head = f'{layout:02X} {kind:02X} {flags:02X} {kept:02X}  {opener}  {acceptor}  {hexadecimal(sequence.to_bytes(8, "big"))}'
    # the one bar parts the prefix from the body, an envelope's own bar within it a space
    return head + (f' | {body.replace(" | ", "  ")}' if body else '')


def identity_of(identifier, incarnation=INCARNATION, bound=None):
    """An OPEN's or an ACCEPT's body: its id's length and its id, its incarnation, its receive bound;
    a GONE's, its incarnation then its id, when bound is None."""
    named = f'{len(identifier):02X}' + (f' {ascii_hex(identifier)}' if identifier else '')
    return f'{named}  {incarnation}  {hexadecimal(bound.to_bytes(4, "big"))}' if bound is not None else f'{incarnation}  {named}'


def fields_of(kind, sequence, *, flags=0, opener=OPENER, acceptor=ACCEPTOR, layout=PARCEL_LAYOUT, **body):
    return {'layout': layout, 'kind': kind, 'flags': flags, 'opener': opener, 'acceptor': acceptor, 'sequence': sequence,
            **body}


def credential_of(credential):
    return f'{hexadecimal(len(credential).to_bytes(2, "big"))}  {ascii_hex(credential)}'


# each kind, read to its fields and written back to its bytes; written false for one a reader reads and
# no writer writes: an advisory kind, a layout to come, and what its acceptor refuses
parcels = [
    ('an OPEN marked secure', ['15.17', ROW[OPEN], '15.18'],
     parcel_of(OPEN, 1, identity_of(PARTICIPANT, bound=65_536), flags=SECURE, acceptor=NO_HALF),
     fields_of(OPEN, 1, flags=SECURE, acceptor=NO_HALF, id=PARTICIPANT, incarnation=INCARNATION, bound=65_536), True),
    ('an OPEN not marked secure, its id of one character and its receive bound the least', ['15.17', ROW[OPEN], '15.18'],
     parcel_of(OPEN, 1, identity_of('p', bound=1_024), acceptor=NO_HALF),
     fields_of(OPEN, 1, acceptor=NO_HALF, id='p', incarnation=INCARNATION, bound=1_024), True),
    ('an ACCEPT marked secure, its id the longest token and its receive bound the largest', ['15.17', ROW[ACCEPT], '15.18'],
     parcel_of(ACCEPT, 1, identity_of(LONGEST_ID, bound=2 ** 32 - 1), flags=SECURE),
     fields_of(ACCEPT, 1, flags=SECURE, id=LONGEST_ID, incarnation=INCARNATION, bound=2 ** 32 - 1), True),
    ('a REFUSE 400 malformed', ['15.17', ROW[REFUSE]], parcel_of(REFUSE, 1, '01 90', acceptor=NO_HALF),
     fields_of(REFUSE, 1, acceptor=NO_HALF, status=400), True),
    ('a REFUSE 426 layout-refused, naming the layouts it reads', ['15.17', ROW[REFUSE]],
     parcel_of(REFUSE, 1, '01 AA  B1', acceptor=NO_HALF), fields_of(REFUSE, 1, acceptor=NO_HALF, status=426, layouts=[0xB1]),
     True),
    ('a REFUSE 426 layout-refused, naming two layouts', ['15.17', ROW[REFUSE]],
     parcel_of(REFUSE, 1, '01 AA  B1 B2', acceptor=NO_HALF),
     fields_of(REFUSE, 1, acceptor=NO_HALF, status=426, layouts=[0xB1, 0xB2]), True),
    ('a REFUSE 503 busy', ['15.17', ROW[REFUSE]], parcel_of(REFUSE, 1, '01 F7', acceptor=NO_HALF),
     fields_of(REFUSE, 1, acceptor=NO_HALF, status=503), True),
    ('a DATA carrying an envelope', ['15.17', ROW[DATA]], parcel_of(DATA, 3, CARRIED), fields_of(DATA, 3, carried=CARRIED),
     True),
    ('a DATA carrying a credential beside an envelope', ['15.17', ROW[DATA], '15.22'],
     parcel_of(DATA, 3, f'{credential_of(CREDENTIAL)}  {CARRIED}', flags=CARRIES_CREDENTIAL),
     fields_of(DATA, 3, flags=CARRIES_CREDENTIAL, credential=CREDENTIAL, carried=CARRIED), True),
    ('a DATA carrying a credential and the first part of an envelope, more to come', ['15.17', ROW[DATA], '15.20'],
     parcel_of(DATA, 3, f'{credential_of(CREDENTIAL)}  {FIRST_PART}', flags=MORE | CARRIES_CREDENTIAL),
     fields_of(DATA, 3, flags=MORE | CARRIES_CREDENTIAL, credential=CREDENTIAL, carried=FIRST_PART), True),
    ('a DATA carrying a part with more to come, and no credential', ['15.17', ROW[DATA], '15.20'],
     parcel_of(DATA, 4, FIRST_PART, flags=MORE), fields_of(DATA, 4, flags=MORE, carried=FIRST_PART), True),
    ('a DATA carrying the last part of an envelope', ['15.17', ROW[DATA], '15.20'], parcel_of(DATA, 5, LAST_PART),
     fields_of(DATA, 5, carried=LAST_PART), True),
    ('a DATA of the largest sequence', ['1.2', '15.17', ROW[DATA]], parcel_of(DATA, 2 ** 53 - 1, CARRIED),
     fields_of(DATA, 2 ** 53 - 1, carried=CARRIED), True),
    ('a PING', ['15.17', ROW[PING]], parcel_of(PING, 2), fields_of(PING, 2), True),
    ('a PONG answering the PING of sequence 2', ['15.17', ROW[PONG]], parcel_of(PONG, 2, '00 00 00 00 00 00 00 02'),
     fields_of(PONG, 2, answers=2), True),
    *[(f'a CLOSE of {code}', ['15.17', ROW[CLOSE]], parcel_of(CLOSE, 4, hexadecimal(code.to_bytes(2, 'big'))),
       fields_of(CLOSE, 4, code=code), True) for code in (1000, 1001, 1002, 1009, 4000, 4001)],
    ('a RESET, its sequence 0', ['15.17', ROW[RESET]], parcel_of(RESET, 0), fields_of(RESET, 0), True),
    ('a GONE, its halves zero and its sequence 0', ['15.17', ROW[GONE]],
     parcel_of(GONE, 0, identity_of(PARTICIPANT), opener=NO_HALF, acceptor=NO_HALF),
     fields_of(GONE, 0, opener=NO_HALF, acceptor=NO_HALF, incarnation=INCARNATION, id=PARTICIPANT), True),
    # an advisory kind is taken in its order and skipped, whatever its flags, its kept byte and its
    # body: a reader reads its prefix alone
    ('an advisory kind, 0x80, read to its prefix', ['15.17'], parcel_of(0x80, 3, '01 02 03'),
     {'layout': PARCEL_LAYOUT, 'kind': 0x80, 'opener': OPENER, 'acceptor': ACCEPTOR, 'sequence': 3}, False),
    ('the last advisory kind, read to its prefix whatever its flags and its kept byte', ['15.17'],
     parcel_of(0xFF, 3, flags=0xFF, kept=0xFF), {'layout': PARCEL_LAYOUT, 'kind': 0xFF, 'opener': OPENER,
                                                 'acceptor': ACCEPTOR, 'sequence': 3}, False),
    # every layout keeps a parcel's 28 bytes of prefix, an OPEN's id at the head of its body, and a
    # REFUSE whole: the OPEN its acceptor refuses 426, and the REFUSE an opener reads of it
    ('an OPEN of a layout to come, 0xB2, read to its prefix and its id', ['15.17', ROW[OPEN], '15.18'],
     parcel_of(OPEN, 1, f'{identity_of(PARTICIPANT, bound=65_536)}  01 02 03 04', flags=0x80, acceptor=NO_HALF,
               layout=LAYOUT_TO_COME),
     {'layout': LAYOUT_TO_COME, 'kind': OPEN, 'opener': OPENER, 'acceptor': NO_HALF, 'sequence': 1, 'id': PARTICIPANT},
     False),
    ('a REFUSE of a layout to come, 0xB2, read whole', ['15.17', ROW[REFUSE]],
     parcel_of(REFUSE, 1, '01 AA  B2', acceptor=NO_HALF, layout=LAYOUT_TO_COME),
     fields_of(REFUSE, 1, acceptor=NO_HALF, layout=LAYOUT_TO_COME, status=426, layouts=[0xB2]), False),
    # what an OPEN's acceptor refuses 400 malformed (spec 15.18) reads, and no participant writes it
    ('an OPEN whose id is no token, read for its acceptor to refuse', ['15.17', ROW[OPEN], '15.18'],
     parcel_of(OPEN, 1, identity_of('a/b', bound=65_536), flags=SECURE, acceptor=NO_HALF),
     fields_of(OPEN, 1, flags=SECURE, acceptor=NO_HALF, id='a/b', incarnation=INCARNATION, bound=65_536), False),
    ('an OPEN whose receive bound is under 1,024 bytes, read for its acceptor to refuse', ['15.17', ROW[OPEN], '15.18'],
     parcel_of(OPEN, 1, identity_of(PARTICIPANT, bound=1_023), flags=SECURE, acceptor=NO_HALF),
     fields_of(OPEN, 1, flags=SECURE, acceptor=NO_HALF, id=PARTICIPANT, incarnation=INCARNATION, bound=1_023), False),
]

NO_PARCEL, DOES_NOT_READ = 'no-parcel', 'does-not-read'

# what a side refuses of a message: no parcel, which it drops in silence and reports, or a parcel that
# does not read, which closes its connection with 1002 (spec 15.17)
parcel_refusals = [
    ('no byte at all', ['15.17'], '', NO_PARCEL),
    ('27 bytes, one short of a prefix', ['15.17'], ' '.join(parcel_of(PING, 2).split()[:27]), NO_PARCEL),
    ('a first byte of 0xB0', ['15.17'], parcel_of(PING, 2, layout=0xB0), NO_PARCEL),
    ('a first byte of 0xC0', ['15.17'], parcel_of(PING, 2, layout=0xC0), NO_PARCEL),
    ('an envelope of 28 bytes, its first byte 0xA1', ['15.17'],
     f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("0123456789abcdef")}', NO_PARCEL),
    ('a kind of 0x00, never one', ['15.17'], parcel_of(0x00, 3), DOES_NOT_READ),
    ('a kind to come, 0x0A', ['15.17'], parcel_of(0x0A, 3), DOES_NOT_READ),
    ('a kind to come, 0x7F', ['15.17'], parcel_of(0x7F, 3), DOES_NOT_READ),
    ('a DATA marked SECURE, a flag its kind does not take', ['15.17', ROW[DATA]], parcel_of(DATA, 3, CARRIED, flags=SECURE),
     DOES_NOT_READ),
    ('a DATA marked 0x08, a flag no kind takes', ['15.17', ROW[DATA]], parcel_of(DATA, 3, CARRIED, flags=0x08), DOES_NOT_READ),
    ('an OPEN marked MORE', ['15.17', ROW[OPEN]],
     parcel_of(OPEN, 1, identity_of(PARTICIPANT, bound=65_536), flags=MORE | SECURE, acceptor=NO_HALF), DOES_NOT_READ),
    ('a PING marked SECURE', ['15.17', ROW[PING]], parcel_of(PING, 2, flags=SECURE), DOES_NOT_READ),
    ('a kept byte of 0x01', ['15.17'], parcel_of(PING, 2, kept=0x01), DOES_NOT_READ),
    ('an OPEN whose opener\'s half is all zero', ['15.17', ROW[OPEN]],
     parcel_of(OPEN, 1, identity_of(PARTICIPANT, bound=65_536), opener=NO_HALF, acceptor=NO_HALF), DOES_NOT_READ),
    ('an OPEN naming an acceptor\'s half', ['15.17', ROW[OPEN]], parcel_of(OPEN, 1, identity_of(PARTICIPANT, bound=65_536)),
     DOES_NOT_READ),
    ('a REFUSE naming an acceptor\'s half', ['15.17', ROW[REFUSE]], parcel_of(REFUSE, 1, '01 F7'), DOES_NOT_READ),
    ('an ACCEPT whose acceptor\'s half is all zero', ['15.17', ROW[ACCEPT]],
     parcel_of(ACCEPT, 1, identity_of(PARTICIPANT, bound=65_536), acceptor=NO_HALF), DOES_NOT_READ),
    ('a DATA whose acceptor\'s half is all zero', ['15.17', ROW[DATA]], parcel_of(DATA, 3, CARRIED, acceptor=NO_HALF),
     DOES_NOT_READ),
    ('a GONE naming a half', ['15.17', ROW[GONE]], parcel_of(GONE, 0, identity_of(PARTICIPANT), acceptor=NO_HALF),
     DOES_NOT_READ),
    ('a sequence past 2⁵³ − 1', ['1.2', '15.17'], parcel_of(DATA, 2 ** 53, CARRIED), DOES_NOT_READ),
    ('a DATA of sequence 0', ['15.17', ROW[DATA]], parcel_of(DATA, 0, CARRIED), DOES_NOT_READ),
    ('a RESET with a sequence', ['15.17', ROW[RESET]], parcel_of(RESET, 3), DOES_NOT_READ),
    ('a GONE with a sequence', ['15.17', ROW[GONE]],
     parcel_of(GONE, 1, identity_of(PARTICIPANT), opener=NO_HALF, acceptor=NO_HALF), DOES_NOT_READ),
    ('an OPEN cut short of its receive bound', ['15.17', ROW[OPEN]],
     ' '.join(parcel_of(OPEN, 1, identity_of(PARTICIPANT, bound=65_536), acceptor=NO_HALF).split()[:-1]), DOES_NOT_READ),
    ('an OPEN with a byte past its receive bound', ['15.17', ROW[OPEN]],
     parcel_of(OPEN, 1, f'{identity_of(PARTICIPANT, bound=65_536)}  00', acceptor=NO_HALF), DOES_NOT_READ),
    ('an ACCEPT whose id is no token', ['15.17', ROW[ACCEPT]], parcel_of(ACCEPT, 1, identity_of('a/b', bound=65_536)),
     DOES_NOT_READ),
    ('an ACCEPT whose id is empty', ['15.17', ROW[ACCEPT]], parcel_of(ACCEPT, 1, identity_of('', bound=65_536)),
     DOES_NOT_READ),
    ('an ACCEPT whose id is past the longest token', ['15.17', ROW[ACCEPT]],
     parcel_of(ACCEPT, 1, identity_of(LONGEST_ID + 'a', bound=65_536)), DOES_NOT_READ),
    ('an ACCEPT whose receive bound is under 1,024 bytes', ['15.17', ROW[ACCEPT], '15.18'],
     parcel_of(ACCEPT, 1, identity_of(PARTICIPANT, bound=1_023)), DOES_NOT_READ),
    ('a GONE whose id is no token', ['15.17', ROW[GONE]],
     parcel_of(GONE, 0, identity_of('a b'), opener=NO_HALF, acceptor=NO_HALF), DOES_NOT_READ),
    ('a GONE cut short of its id', ['15.17', ROW[GONE]],
     ' '.join(parcel_of(GONE, 0, identity_of(PARTICIPANT), opener=NO_HALF, acceptor=NO_HALF).split()[:-1]), DOES_NOT_READ),
    ('a PING with a body', ['15.17', ROW[PING]], parcel_of(PING, 2, '00'), DOES_NOT_READ),
    ('a PONG cut short', ['15.17', ROW[PONG]], parcel_of(PONG, 2, '00 00 00 00 00 00 02'), DOES_NOT_READ),
    ('a RESET with a body', ['15.17', ROW[RESET]], parcel_of(RESET, 0, '00'), DOES_NOT_READ),
    ('a CLOSE of 1003, a code it does not name', ['15.17', ROW[CLOSE]], parcel_of(CLOSE, 4, '03 EB'), DOES_NOT_READ),
    ('a CLOSE cut short', ['15.17', ROW[CLOSE]], parcel_of(CLOSE, 4, '03'), DOES_NOT_READ),
    ('a REFUSE of 404, a status it does not name', ['15.17', ROW[REFUSE]], parcel_of(REFUSE, 1, '01 94', acceptor=NO_HALF),
     DOES_NOT_READ),
    ('a REFUSE 426 naming no layout', ['15.17', ROW[REFUSE]], parcel_of(REFUSE, 1, '01 AA', acceptor=NO_HALF),
     DOES_NOT_READ),
    ('a REFUSE 503 with a byte after its status', ['15.17', ROW[REFUSE]],
     parcel_of(REFUSE, 1, '01 F7  00', acceptor=NO_HALF), DOES_NOT_READ),
    ('a DATA marked CREDENTIAL whose credential runs past its bytes', ['15.17', ROW[DATA]],
     parcel_of(DATA, 3, f'00 40  {ascii_hex("Interop")}', flags=CARRIES_CREDENTIAL), DOES_NOT_READ),
    ('a DATA marked CREDENTIAL whose credential is empty', ['15.17', ROW[DATA]],
     parcel_of(DATA, 3, f'00 00  {CARRIED}', flags=CARRIES_CREDENTIAL), DOES_NOT_READ),
    ('a DATA carrying nothing', ['15.17', ROW[DATA]], parcel_of(DATA, 3), DOES_NOT_READ),
    ('a DATA marked CREDENTIAL carrying nothing past its credential', ['15.17', ROW[DATA]],
     parcel_of(DATA, 3, credential_of(CREDENTIAL), flags=CARRIES_CREDENTIAL), DOES_NOT_READ),
]


# ── An MQTT 5 PUBLISH's bytes (section 15.30) ────────────────────────────────────────────────────

# an inbox of the server, and one of a 64-character id, the longest token (section 15.16): base64url's
# whole alphabet
SERVER_INBOX = 'bead/i/server'
LONGEST_INBOX = 'bead/i/' + string.ascii_uppercase + string.ascii_lowercase + string.digits + '-_'
assert len(LONGEST_INBOX) == len('bead/i/') + 64


def bound_of(remaining):
    """The bound whose largest packet has that Remaining Length: its every byte."""
    return 1 + width(remaining) + remaining


# the bounds a count is held at: each side of each width of a Remaining Length, then a participant's
# least receive bound and its broker's, its own maximumPacketSize by default, and the protocol's largest
# packet, which a CONNACK that names none leaves
PUBLISH_BOUNDS = [*[bound_of(remaining) for remaining in (127, 128, 16_383, 16_384, 2_097_151, 2_097_152)],
                  1_052, 4_096, MAXIMUM_PACKET_SIZE, LARGEST_PACKET]
assert PUBLISH_BOUNDS[:6] == [129, 131, 16_386, 16_388, 2_097_155, 2_097_157]


def topic_named(topic):
    return topic if topic == SERVER_INBOX else 'an inbox of a 64-character id'


def publish_bound(topic, maximum, qos, expiry):
    largest = largest_payload(topic, maximum, qos=qos, expiry=expiry)
    packet = None if largest is None else publish_bytes(len(topic.encode('utf-8')), largest, qos=qos, expiry=expiry)
    remaining = None if largest is None else remaining_length(len(topic.encode('utf-8')), largest, qos=qos, expiry=expiry)
    assert packet is None or packet <= maximum
    life = 'with a life' if expiry else 'without a life'
    named = f'{topic_named(topic)} at QoS {qos} {life}, under {maximum:,} bytes'
    return (named + ('' if remaining is None else f': a Remaining Length of {remaining:,}'), ['15.30'], topic, maximum,
            qos, expiry, largest, packet)


mqtt_publish_bounds = [publish_bound(topic, maximum, qos, expiry)
                       for topic in (SERVER_INBOX, LONGEST_INBOX) for qos in (1, 0) for expiry in (True, False)
                       for maximum in PUBLISH_BOUNDS]
# ! an empty PUBLISH to the server's inbox at QoS 1 with a life is 25 bytes: under 24 none fits
mqtt_publish_bounds.append(('no payload fits: ' + publish_bound(SERVER_INBOX, 24, 1, True)[0], ['15.30'],
                            SERVER_INBOX, 24, 1, True, None, None))
assert mqtt_publish_bounds[-1][6] is None and publish_bytes(len(SERVER_INBOX), 0, qos=1, expiry=True) == 25


def entry(**fields):
    return {key: value for key, value in fields.items() if value is not None}



def step_seven(clauses, code, detail):
    """A header refused ENVELOPE_MALFORMED whose detail says which check failed plays 5.2 besides its
    own units: within step 7, the detail says which check refused it."""
    return [*clauses, '5.2'] if code == MALFORMED and detail is not None else clauses


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
        "A credential refusal gives the scheme a request presents, by its name or, to come, its number, and the situation a test sets up on a server of its own before it: another-connections-session, an OPAQUE of the session another connection holds; no-session, an OPAQUE no session holds; nothing-carried, an ELSEWHERE whose transport carried nothing; verifier-makes-none, an ELSEWHERE its verifier settles with no session of; end-come, an ELSEWHERE whose end the wall clock has reached as its verifier settles; scheme-to-come; no-verifier, an ELSEWHERE to a server given no verifier; no-keys, a JWT to a server given no keys and no key set. Then the code the request is answered with, and the one word the server tells the access it refused with (section 13.12); a JWT's reasons are its verdicts', the step of section 13.8 that refused it.",
        "A parcel is a broker's message, read to its fields and written back to its bytes (section 15.17): its layout, 177 for 0xB1; its kind, OPEN 1, ACCEPT 2, REFUSE 3, DATA 4, PING 5, PONG 6, CLOSE 7, RESET 8, GONE 9, 128 to 255 advisory; its flags, MORE 1, CREDENTIAL 2 and SECURE 4 together; its opener's half and its acceptor's, 8 bytes each in hexadecimal; its sequence; then its body's fields: an OPEN's and an ACCEPT's id, a character a byte, incarnation, in hexadecimal, and bound, its receive bound; a REFUSE's status, and layouts, those it reads, on a 426; a DATA's credential, a character a byte, where it carries one, and carried, the envelope or the part it carries, in hexadecimal; a PONG's answers, the sequence of the PING it answers; a CLOSE's code; a GONE's incarnation and id. A field a parcel's kind has no part for is left out.",
        "written false marks a parcel a reader reads and no writer writes, which a side reads alone: an advisory kind, read to its prefix — layout, kind, halves and sequence — whatever its flags, its kept byte and its body, to be taken in its order and skipped; an OPEN of a layout to come, read to its prefix and its id, which its acceptor refuses 426; a REFUSE of a layout to come, read whole, which every layout keeps; and an OPEN whose id is no token or whose receive bound is under 1,024, which its acceptor refuses 400 (section 15.18).",
        "A parcel refusal is what a side makes of a message that does not read as a parcel: no-parcel, under 28 bytes or of a first byte outside 0xB1 to 0xBF, which it drops in silence and reports; or does-not-read, a parcel of layout 0xB1 that does not read, which closes its connection with 1002, reported.",
        "An MQTT 5 publish bound is section 15.30's count with no broker: a PUBLISH to topic, its UTF-8 bytes, at qos, 1 or 0, with a Message Expiry Interval where expiry is true; largestPayload, the largest payload whose packet is within maximumPacketSize and whose Remaining Length is at most 268,435,455, null where an empty one does not fit; and packetBytes, that packet's every byte, null alike.",
    ],
    'specVersion': spec_version(),
    'headers': [entry(name=name, clauses=clauses, bytes=data, header=header) for name, clauses, data, header in headers],
    'reads': [{'name': name, 'clauses': clauses, 'side': side, 'bytes': data, 'header': header}
              for name, clauses, side, data, header in reads],
    'prefixes': [entry(name=name, clauses=clauses, bytes=data, prefix=prefix) for name, clauses, data, prefix in prefixes],
    'prefixRefusals': [entry(name=name, clauses=clauses, bytes=data, code=MALFORMED) for name, clauses, data in prefix_refusals],
    'headerRefusals': [entry(name=name, clauses=step_seven(clauses, code, detail), bytes=data, code=code, detail=detail)
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
    'credentialRefusals': [{'name': name, 'clauses': clauses, 'scheme': scheme, 'situation': situation, 'code': code,
                            'reason': reason}
                           for name, clauses, scheme, situation, code, reason in credential_refusals],
    'parcels': [{'name': name, 'clauses': clauses, 'bytes': data, 'parcel': parcel, **({} if written else {'written': False})}
                for name, clauses, data, parcel, written in parcels],
    'parcelRefusals': [{'name': name, 'clauses': clauses, 'bytes': data, 'refused': refused}
                       for name, clauses, data, refused in parcel_refusals],
    'mqttPublishBounds': [{'name': name, 'clauses': clauses, 'topic': topic, 'maximumPacketSize': maximum, 'qos': qos,
                           'expiry': expiry, 'largestPayload': largest, 'packetBytes': packet}
                          for name, clauses, topic, maximum, qos, expiry, largest, packet in mqtt_publish_bounds],
}

with open(OUT, 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print({key: len(value) for key, value in document.items() if isinstance(value, list) and key != '$comment'})
