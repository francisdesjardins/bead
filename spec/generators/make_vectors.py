"""Writes spec/vectors.json: Bead's conformance vectors, the one source every implementation's tests read."""
import json
import os

# the conformance files sit one folder up from their generators
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vectors.json')

TOKEN = 'AAECAwQFBgcICQoLDA0ODw'
TOKEN_BYTES = '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'
ZEROS = '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'

MALFORMED = 1
LAYOUT_UNSUPPORTED = 2
KIND_UNSUPPORTED = 3
ENVELOPE_TOO_LARGE = 4


def ascii_hex(text):
    return ' '.join(f'{byte:02X}' for byte in text.encode('utf-8'))


headers = [
    ('a request', 'A1 10 00 03  00 00 00 03  00 02 00 01', {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2}),
    ('a result', 'A1 11 00 02  00 00 00 03', {'callId': 3, 'kind': 17}),
    ('a failure', 'A1 12 00 02  00 00 00 03', {'callId': 3, 'kind': 18}),
    ('a notification', 'A1 13 00 02  00 00 00 0D', {'callId': 13, 'kind': 19}),
    ('a cancel', 'A1 16 00 02  00 00 00 05', {'callId': 5, 'kind': 22}),
    ('a request with a destination', 'A1 10 02 04  00 00 00 09  00 02 00 07  00 00 00 05',
     {'callId': 9, 'destinationId': 5, 'kind': 16, 'procedureId': 7, 'serviceId': 2}),
    ('a result with a session', f'A1 11 01 06  00 00 00 03  {TOKEN_BYTES}', {'callId': 3, 'kind': 17, 'sessionToken': TOKEN}),
    ('a result that ends the session', f'A1 11 01 06  00 00 00 03  {ZEROS}', {'callId': 3, 'kind': 17, 'sessionToken': None}),
    ('a failure that ends the session', f'A1 12 01 06  00 00 00 03  {ZEROS}', {'callId': 3, 'kind': 18, 'sessionToken': None}),
    ('a request with a session and a destination', f'A1 10 03 08  00 00 00 07  00 02 00 01  {TOKEN_BYTES}  00 00 00 0C',
     {'callId': 7, 'destinationId': 12, 'kind': 16, 'procedureId': 1, 'serviceId': 2, 'sessionToken': TOKEN}),
    ('a request that opens a subscription', 'A1 10 10 03  00 00 00 03  00 02 00 01',
     {'callId': 3, 'kind': 16, 'opensSubscription': True, 'procedureId': 1, 'serviceId': 2}),
    ('a request that opens a subscription, paced', 'A1 10 30 03  00 00 00 05  00 02 00 01',
     {'callId': 5, 'kind': 16, 'opensSubscription': True, 'paced': True, 'procedureId': 1, 'serviceId': 2}),
    ('a request that opens a subscription, with a session and a destination',
     f'A1 10 13 08  00 00 00 07  00 02 00 01  {TOKEN_BYTES}  00 00 00 0C',
     {'callId': 7, 'destinationId': 12, 'kind': 16, 'opensSubscription': True, 'procedureId': 1, 'serviceId': 2, 'sessionToken': TOKEN}),
    ('a request that opens a transfer', 'A1 10 04 05  00 00 00 07  00 02 00 05  00 00 00 00 01 40 00 00',
     {'callId': 7, 'kind': 16, 'procedureId': 5, 'serviceId': 2, 'total': 20971520}),
    ('a request with a destination that opens a transfer of nothing',
     'A1 10 06 06  00 00 00 09  00 02 00 07  00 00 00 05  00 00 00 00 00 00 00 00',
     {'callId': 9, 'destinationId': 5, 'kind': 16, 'procedureId': 7, 'serviceId': 2, 'total': 0}),
    ('a result with a session that opens a transfer', f'A1 11 05 08  00 00 00 03  {TOKEN_BYTES}  00 00 00 00 00 00 10 00',
     {'callId': 3, 'kind': 17, 'sessionToken': TOKEN, 'total': 4096}),
    ('a chunk with more to come', 'A1 14 40 04  00 00 00 07  00 00 00 00 00 0F FF EC',
     {'callId': 7, 'isLast': False, 'kind': 20, 'offset': 1048556}),
    ('the last chunk', 'A1 14 00 04  00 00 00 07  00 00 00 00 01 3F FE BC',
     {'callId': 7, 'isLast': True, 'kind': 20, 'offset': 20971196}),
    ('a credit', 'A1 15 00 04  00 00 00 07  00 00 00 00 00 4F FF EC', {'callId': 7, 'creditEnd': 5242860, 'kind': 21}),
    ('a credit of notifications', 'A1 15 20 04  00 00 00 05  00 00 00 00 00 00 00 03',
     {'callId': 5, 'creditEnd': 3, 'kind': 21, 'paced': True}),
    # the call ids past 2^31, unsigned, and the largest of each 64-bit field
    ('a result on the last call id', 'A1 11 00 02  FF FF FF FF', {'callId': 4294967295, 'kind': 17}),
    ('a request at the last of every range', 'A1 10 02 04  FF FF FF FF  FF FF FF FF  FF FF FF FF',
     {'callId': 4294967295, 'destinationId': 4294967295, 'kind': 16, 'procedureId': 65535, 'serviceId': 65535}),
    ('a credit at 2^53 - 1, the largest end', 'A1 15 00 04  00 00 00 07  00 1F FF FF FF FF FF FF',
     {'callId': 7, 'creditEnd': 9007199254740991, 'kind': 21}),
    ('a credit past 2^32, its high word first', 'A1 15 00 04  00 00 00 01  00 00 00 01 00 00 00 05',
     {'callId': 1, 'creditEnd': 4294967301, 'kind': 21}),
]

# headers a reader takes, which a writer need not write: what it reads, or null for a kind skipped
reads = [
    ('a request opening a transfer of 40 MiB', 'server', 'A1 10 04 05  00 00 00 03  00 02 00 01  00 00 00 00 02 80 00 00',
     {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2, 'total': 41943040}),
    ('a result opening a transfer of nothing, read by a client', 'client', 'A1 11 04 04  00 00 00 02  00 00 00 00 00 00 00 00',
     {'callId': 2, 'kind': 17, 'total': 0}),
    ('a request to service 0, for routing to refuse', 'server', 'A1 10 00 03  00 00 00 03  00 00 00 01',
     {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 0}),
    ('an advisory kind, skipped', 'server', 'A1 80 00 02  00 00 00 03', None),
    ('the last advisory kind, skipped whatever follows', 'server', 'A1 FF FF FF  00 00 00 00', None),
]

# the first 8 bytes, read by every layout, even one to come
prefixes = [
    ('the prefix of a layout to come', 'AF 7E 55 00  80 00 00 01', {'callId': 2147483649, 'kind': 126, 'layout': 175}),
]

prefix_refusals = [
    ('no byte at all', ''),
    ('7 bytes', 'A1 10 00 03  00 00 00'),
    ('a first byte of 0x0A', '0A 10 00 03  00 00 00 03'),
    ('a first byte of 0x00', '00 10 00 03  00 00 00 03'),
    ('a first byte of 0xA0', 'A0 10 00 03  00 00 00 03'),
    ('a first byte of 0xB0', 'B0 10 00 03  00 00 00 03'),
]

header_refusals = [
    ('a layout to come, 0xA2', 'A2 10 00 03  00 00 00 03  00 02 00 01', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a layout to come, 0xAF', 'AF 10 00 03  00 00 00 03  00 02 00 01', LAYOUT_UNSUPPORTED, '0xA1'),
    # the order a reader checks in: the layout, then the kind, then the call id
    ('a layout to come, before a kind that is never one and a call id of 0', 'A2 00 00 02  00 00 00 00', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a layout to come, before an advisory kind', 'A2 80 00 02  00 00 00 03', LAYOUT_UNSUPPORTED, '0xA1'),
    ('a kind to come, before a call id of 0', 'A1 17 00 02  00 00 00 00', KIND_UNSUPPORTED, None),
    ('a kind of 0x00, never one', 'A1 00 00 02  00 00 00 03', MALFORMED, None),
    ('a kind of 0x0F, never one', 'A1 0F 00 02  00 00 00 03', MALFORMED, None),
    ('a kind to come, 0x17', 'A1 17 00 02  00 00 00 03', KIND_UNSUPPORTED, None),
    ('a kind to come, 0x7F', 'A1 7F 00 02  00 00 00 03', KIND_UNSUPPORTED, None),
    ('a call id of 0', 'A1 11 00 02  00 00 00 00', MALFORMED, None),
    ('the reserved bit 0x08 on a request', 'A1 10 08 03  00 00 00 03  00 02 00 01', MALFORMED, None),
    ('the bit 0x40 on a request', 'A1 10 40 03  00 00 00 03  00 02 00 01', MALFORMED, None),
    ('the reserved bit 0x80 on a request', 'A1 10 80 03  00 00 00 03  00 02 00 01', MALFORMED, None),
    ('a request paced that opens no subscription', 'A1 10 20 03  00 00 00 03  00 02 00 01', MALFORMED,
     'a request paced opens a subscription'),
    ('a total of 2^53, no safe integer', 'A1 11 04 04  00 00 00 02  00 20 00 00 00 00 00 00', MALFORMED, None),
    ('a total not counted in the header length', 'A1 10 04 03  00 00 00 03  00 02 00 01  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a total on a failure', 'A1 12 04 04  00 00 00 03  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a total on a notification', 'A1 13 04 04  00 00 00 03  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a destination on a result', 'A1 11 02 03  00 00 00 03  00 00 00 05', MALFORMED, None),
    ('a destination on a failure', 'A1 12 02 03  00 00 00 03  00 00 00 05', MALFORMED, None),
    ('a session on a cancel', f'A1 16 01 06  00 00 00 05  {TOKEN_BYTES}', MALFORMED, None),
    ('a destination on a cancel', 'A1 16 02 03  00 00 00 05  00 00 00 07', MALFORMED, None),
    ('a total on a cancel', 'A1 16 04 04  00 00 00 05  00 00 00 00 00 00 00 08', MALFORMED, None),
    ('an offset of 2^53', 'A1 14 00 04  00 00 00 07  00 20 00 00 00 00 00 00', MALFORMED, None),
    ('an end of 2^64 - 1', 'A1 15 00 04  00 00 00 07  FF FF FF FF FF FF FF FF', MALFORMED, None),
    ('a chunk on call 0', 'A1 14 00 04  00 00 00 00  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a credit on call 0', 'A1 15 00 04  00 00 00 00  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('a session on a chunk', f'A1 14 01 08  00 00 00 07  00 00 00 00 00 00 00 00  {TOKEN_BYTES}', MALFORMED, None),
    ('a total on a credit', 'A1 15 04 06  00 00 00 07  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 10', MALFORMED, None),
    ('MORE on a credit', 'A1 15 40 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('the reserved bit 0x08 on a chunk', 'A1 14 08 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('PACED on a chunk', 'A1 14 20 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('SUBSCRIPTION on a credit', 'A1 15 10 04  00 00 00 07  00 00 00 00 00 00 00 00', MALFORMED, None),
    ('MORE on a result', 'A1 11 40 02  00 00 00 07', MALFORMED, None),
] + [
    (f'{flag_name} on a {kind_name}', f'A1 {kind} {flag} 02  00 00 00 03', MALFORMED, None)
    for kind, kind_name in (('11', 'result'), ('12', 'failure'), ('13', 'notification'), ('16', 'cancel'))
    for flag, flag_name in (('10', 'SUBSCRIPTION'), ('20', 'PACED'))
] + [
    ('a session on a notification', f'A1 13 01 06  00 00 00 03  {TOKEN_BYTES}', MALFORMED, None),
    ('a destination on a notification', 'A1 13 02 03  00 00 00 03  00 00 00 05', MALFORMED, None),
] + [
    (f'a header length of {words} words, not its blocks\'', f'A1 10 00 {words}  00 00 00 03  00 02 00 01  00 00 00 00', MALFORMED, None)
    for words in ('00', '01', '02', '04')
] + [
    ('a header running past the message', 'A1 10 00 03  00 00 00 03  00 02', MALFORMED, None),
    ('a destination running past the message', 'A1 10 02 04  00 00 00 03  00 02 00 01  00 00', MALFORMED, None),
    ('a destination of 0', 'A1 10 02 04  00 00 00 03  00 02 00 01  00 00 00 00', MALFORMED, None),
    ('a procedure of 0', 'A1 10 00 03  00 00 00 03  00 02 00 00', MALFORMED, None),
    ('a request presenting an ended session', f'A1 10 01 07  00 00 00 03  00 02 00 01  {ZEROS}', MALFORMED, None),
]

envelopes = [
    ('a request, 14 bytes for 3/2/1 and "hi"', f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}',
     {'kind': 16, 'header': {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2}, 'payload': ascii_hex('hi')}),
    ('a result', 'A1 11 00 02  00 00 00 03 | 01 02',
     {'kind': 17, 'header': {'callId': 3, 'kind': 17}, 'payload': '01 02'}),
    ('a notification with no payload', 'A1 13 00 02  00 00 00 0D',
     {'kind': 19, 'header': {'callId': 13, 'kind': 19}, 'payload': ''}),
    ('a cancel, nothing after its header', 'A1 16 00 02  00 00 00 05',
     {'kind': 22, 'header': {'callId': 5, 'kind': 22}}),
    ('a protocol failure, its record after the header',
     f'A1 12 00 02  00 00 00 03 | 00 13 00 00  {ascii_hex("no procedure 1 in service 2")}',
     {'kind': 18, 'header': {'callId': 3, 'kind': 18},
      'failure': {'code': 19, 'detail': 'no procedure 1 in service 2', 'hops': 0, 'scope': 0}}),
    ('an application failure', f'A1 12 00 02  00 00 00 03 | 00 15 00 01  {ascii_hex("out of range")}',
     {'kind': 18, 'header': {'callId': 3, 'kind': 18},
      'failure': {'code': 21, 'detail': 'out of range', 'hops': 0, 'scope': 1}}),
    ('the smallest failure, 12 bytes', 'A1 12 00 02  00 00 00 03 | 00 13 00 00',
     {'kind': 18, 'header': {'callId': 3, 'kind': 18}, 'failure': {'code': 19, 'detail': '', 'hops': 0, 'scope': 0}}),
    ('a request opening a transfer, its payload the first bytes',
     'A1 10 04 05  00 00 00 03  00 02 00 01  00 00 00 00 02 80 00 00 | 01',
     {'kind': 16, 'header': {'callId': 3, 'kind': 16, 'procedureId': 1, 'serviceId': 2, 'total': 41943040}, 'payload': '01'}),
    ('a result opening a transfer of nothing', 'A1 11 04 04  00 00 00 02  00 00 00 00 00 00 00 00',
     {'kind': 17, 'header': {'callId': 2, 'kind': 17, 'total': 0}, 'payload': ''}),
    ('a chunk with more to come', 'A1 14 40 04  00 00 00 07  00 00 00 00 00 00 00 05 | 01 02 03',
     {'kind': 20, 'header': {'callId': 7, 'isLast': False, 'kind': 20, 'offset': 5}, 'payload': '01 02 03'}),
    ('a credit, nothing after its header', 'A1 15 00 04  00 00 00 07  00 00 00 00 00 00 00 0A',
     {'kind': 21, 'header': {'callId': 7, 'creditEnd': 10, 'kind': 21}}),
]

envelope_refusals = [
    ('a cancel with a byte after its header', 'A1 16 00 02  00 00 00 05 | 00', None, MALFORMED, 'a cancel carries no payload, not 1 bytes'),
    ('a chunk without a byte', 'A1 14 00 04  00 00 00 07  00 00 00 00 00 00 00 00', None, MALFORMED, 'a chunk carries one byte at least'),
    ('a credit with a byte after its header', 'A1 15 00 04  00 00 00 07  00 00 00 00 00 00 00 08 | 01', None, MALFORMED,
     'a credit carries no payload, not 1 bytes'),
    # the bound on a whole envelope, checked once its first byte says it is one, before its layout
    ('an envelope past its bound', f'A1 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13, ENVELOPE_TOO_LARGE,
     'an envelope is 13 bytes at most, not 14'),
    ('a layout to come past the bound, its length checked first', f'A2 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13,
     ENVELOPE_TOO_LARGE, None),
    ('7 bytes past a bound of 4, short of a prefix first', 'A1 10 00 03  00 00 00', 4, MALFORMED, None),
    ('a first byte no layout is, past the bound', f'B0 10 00 03  00 00 00 03  00 02 00 01 | {ascii_hex("hi")}', 13, MALFORMED, None),
]

failures = [
    ('the hops as they came, and no detail as empty', '00 12 03 00', None, {'code': 18, 'detail': '', 'hops': 3, 'scope': 0}),
    ('the last code, of the application', 'FF FF 00 01', None, {'code': 65535, 'detail': '', 'hops': 0, 'scope': 1}),
    ('a detail cut at 5 bytes, back to the start of the character cut', f'00 13 00 00  {ascii_hex("abcdéf")}', 5,
     {'code': 19, 'detail': 'abcd', 'hops': 0, 'scope': 0}),
    ('a detail cut at 3 bytes, on a character boundary', f'00 13 00 00  {ascii_hex("abcdéf")}', 3,
     {'code': 19, 'detail': 'abc', 'hops': 0, 'scope': 0}),
    ('a leading U+FEFF kept', '00 13 00 00  EF BB BF 61', None, {'code': 19, 'detail': '\ufeffa', 'hops': 0, 'scope': 0}),
    ('a byte that is not UTF-8, read as U+FFFD', '00 13 00 00  61 FF', None, {'code': 19, 'detail': 'a\ufffd', 'hops': 0, 'scope': 0}),
    # the maximal subparts of the WHATWG decoder: one U+FFFD for each run that could have begun a character
    ('a detail ending inside a character, one U+FFFD', '00 13 00 00  61 E2 82', None,
     {'code': 19, 'detail': 'a\ufffd', 'hops': 0, 'scope': 0}),
    ('a character cut short by another, one U+FFFD before it', '00 13 00 00  F0 9F 98 41', None,
     {'code': 19, 'detail': '\ufffdA', 'hops': 0, 'scope': 0}),
    ('a surrogate spelled in UTF-8, one U+FFFD a byte', '00 13 00 00  ED A0 80', None,
     {'code': 19, 'detail': '\ufffd\ufffd\ufffd', 'hops': 0, 'scope': 0}),
]

failure_refusals = [
    ('no byte at all', ''),
    ('3 bytes, fewer than a record', '00 13 00'),
    ('a code of 0', '00 00 00 00'),
    ('the flag 0x02', '00 13 00 02'),
    ('the flag 0x04', '00 13 00 04'),
    ('the flag 0x80', '00 13 00 80'),
    ('the flags 0x03', '00 13 00 03'),
]


def entry(**fields):
    return {key: value for key, value in fields.items() if value is not None}


document = {
    '$comment': [
        "Bead's conformance vectors: the bytes of envelopes and what they say, written once and read by every implementation's tests.",
        'Bytes are hexadecimal, spaces aside; a bar parts a header from what follows it.',
        "A header is the fields an envelope's header carries; sessionToken is the token in base64url, or null for the end of a session.",
        'kind: REQUEST 16, RESULT 17, FAILURE 18, NOTIFICATION 19, CHUNK 20, CREDIT 21, CANCEL 22. scope: PROTOCOL 0, APPLICATION 1.',
        "A refusal names the protocol code a reader answers with; its detail, where given, is what the TypeScript implementation says, and is informative: an implementation compares the code.",
        "maximumEnvelopeBytes and maximumDetailBytes, where given, are the reader's bounds; where not, the vector is within any bound.",
        "side is the side that reads: a failure says which side raised it.",
    ],
    'headers': [entry(name=name, bytes=data, header=header) for name, data, header in headers],
    'reads': [{'name': name, 'side': side, 'bytes': data, 'header': header} for name, side, data, header in reads],
    'prefixes': [entry(name=name, bytes=data, prefix=prefix) for name, data, prefix in prefixes],
    'prefixRefusals': [entry(name=name, bytes=data, code=MALFORMED) for name, data in prefix_refusals],
    'headerRefusals': [entry(name=name, bytes=data, code=code, detail=detail) for name, data, code, detail in header_refusals],
    'envelopes': [entry(name=name, bytes=data, envelope=envelope) for name, data, envelope in envelopes],
    'envelopeRefusals': [entry(name=name, bytes=data, maximumEnvelopeBytes=maximum, code=code, detail=detail)
                         for name, data, maximum, code, detail in envelope_refusals],
    'failures': [entry(name=name, record=record, maximumDetailBytes=maximum, failure=failure) for name, record, maximum, failure in failures],
    'failureRefusals': [entry(name=name, record=record, code=MALFORMED) for name, record in failure_refusals],
}

with open(OUT, 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print({key: len(value) for key, value in document.items() if isinstance(value, list) and key != '$comment'})
