"""What the generators share: the folder the conformance files sit in and the writer of each file, bytes
as the files write them, the steps of a case on the server's clock, the requests a case writes behind
an exchange's and their bound, the order of an entry's units, the spec's codes, a failure's detail,
and the small searches and values more than one generator draws on."""
import json
import os
import re

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

# section 8 of spec.md: its codes, by number
CODES = {
    1: 'ENVELOPE_MALFORMED', 2: 'LAYOUT_UNSUPPORTED', 3: 'KIND_UNSUPPORTED', 4: 'ENVELOPE_TOO_LARGE',
    16: 'DESTINATION_UNKNOWN', 17: 'DESTINATION_UNREACHABLE', 18: 'SERVICE_UNKNOWN', 19: 'PROCEDURE_UNKNOWN',
    20: 'CALL_UNKNOWN', 21: 'SUBSCRIPTION_UNKNOWN', 22: 'SUBSCRIPTION_UNSUPPORTED',
    32: 'SESSION_REQUIRED', 33: 'ACCESS_DENIED', 34: 'PAYLOAD_TOO_LARGE', 35: 'CAPACITY_EXCEEDED',
    36: 'CREDENTIAL_UNSUPPORTED', 48: 'CHUNK_INVALID', 49: 'CREDIT_EXCEEDED', 50: 'PAYLOAD_UNDECODABLE',
    51: 'TRANSFER_STALLED', 52: 'PAYLOAD_INVALID', 64: 'PROCEDURE_FAILED', 65: 'DESTINATION_LOST',
}


# ── Bytes, as the files write them ──────────────────────────────────────────────────────────────


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


def word(value, length):
    """An unsigned integer on that many bytes, big-endian."""
    return hexadecimal(value.to_bytes(length, 'big'))


def text(value):
    """A string's UTF-8."""
    return hexadecimal(value.encode('utf-8'))


# ── A case's steps on the server's clock ────────────────────────────────────────────────────────


def armed(milliseconds):
    """A timer armed on the server's clock, due that many milliseconds from now."""
    return {'until': {'timer': milliseconds}}


def advance(milliseconds):
    return {'advance': milliseconds}


# ── Requests written behind an exchange's ───────────────────────────────────────────────────────

# the octets one behind writes at most, within what a host's socket takes, so that no player's write
# waits on a server that reads nothing more: a case holds a server's outcome, never its read-ahead
BEHIND_BOUND = 65_536
# what a value put in a head, {host} or one captured, counts for against that bound: more than any
# IP literal and port, token or entity tag, the longest of them 66 octets, takes
PUT_IN = 128
# * the requests a case pipelines in one write behind an answer held (spec 15.12), sized by their
# octets, each value put in counted as written, the least a server reads of them: past hyper's first
# read of a socket, 8,192 octets, its INIT_BUFFER_SIZE, so that hyper reads again once it served what
# it read, and far past the 32 the TypeScript side holds unserved before it stops reading a socket.
# Kestrel reads ahead to 1 MB, past BEHIND_BOUND, so no case reaches its stop: its twins do
PIPELINED = 200
HYPER_FIRST_READ = 8_192


def octets_written(requests, *, put_in=None):
    """The octets requests take in one write: each head's characters, one octet each, and its body's
    octets; each value put in, {name}, counted as written, or as put_in octets where it is given."""
    return sum(len(request['head'] if put_in is None else re.sub(r'\{[a-z][a-zA-Z0-9]*\}', 'x' * put_in, request['head']))
               + len(request.get('body', '').replace('|', ' ').split())
               for request in requests)


def pipelined(step):
    """A behind that pipelines requests behind an answer held, checked against what sizes them: past
    hyper's first read and far past the TypeScript side's 32, within BEHIND_BOUND."""
    requests = step['behind']
    assert len(requests) > 32 and octets_written(requests) > HYPER_FIRST_READ, 'past every read-ahead a case reaches'
    assert octets_written(requests, put_in=PUT_IN) <= BEHIND_BOUND, 'within what one behind writes'
    return step


# ── A failure's detail ──────────────────────────────────────────────────────────────────────────


def detail_by_default(code, scope, detail):
    """The detail an expected failure gives: its own, or, for a PROCEDURE_FAILED of the protocol's
    that gives none, the empty one, since 9.0 has a side answer an error of its own with no detail."""
    return '' if detail is None and code == 64 and scope == 0 else detail


def pins_no_detail(value):
    """Whether a case's steps expect a PROCEDURE_FAILED of the protocol's with its empty detail."""
    if isinstance(value, dict):
        failure = value.get('failure')

        if isinstance(failure, dict) and failure.get('code') == 64 and failure.get('scope') == 0                 and failure.get('detail') == '':
            return True

        return any(pins_no_detail(member) for member in value.values())

    return isinstance(value, list) and any(pins_no_detail(item) for item in value)


def citing_no_detail(clauses, steps):
    """A case's units, with 9.0 before the first that follows it where its steps pin a
    PROCEDURE_FAILED's empty detail."""
    if '9.0' in clauses or not pins_no_detail(steps):
        return clauses

    at = next((index for index, unit in enumerate(clauses) if unit_order(unit) > unit_order('9.0')), len(clauses))
    return [*clauses[:at], '9.0', *clauses[at:]]


# ── Searches and values ─────────────────────────────────────────────────────────────────────────


def unit_order(unit):
    """A unit's place among an entry's: the units of the file's own document first, which no name comes
    before, then each other document's behind its name and a colon, each in the order of its numbers."""
    document, _, number = unit.rpartition(':')
    return document, tuple(int(part) for part in number.split('.'))


def largest(fits, high):
    """The largest count from 0 to high that fits, or None where 0 does not: found by a search, fits
    holding up to a count and failing past it."""
    if not fits(0):
        return None

    low = 0

    while low < high:
        middle = (low + high + 1) // 2
        low, high = (middle, high) if fits(middle) else (low, middle - 1)

    return low


def nested(depth):
    """Arrays nested that many deep, the outermost at depth 1."""
    value = []

    for _ in range(depth - 1):
        value = [value]

    return value


def write_text(name, text):
    """A file of spec/ written whole, in UTF-8, each line ended by a line feed."""
    with open(ROOT + name, 'w', encoding='utf-8', newline='\n') as file:
        file.write(text)


def write_json(name, document, *, ensure_ascii=False, line_separators_escaped=False):
    """A conformance file: its document as JSON, two spaces to a level, then a line feed. A character
    outside ASCII is written as it is, or as its escape where ensure_ascii is set; U+2028 and U+2029
    alone are escaped where line_separators_escaped is."""
    text = json.dumps(document, ensure_ascii=ensure_ascii, indent=2)

    if line_separators_escaped:
        text = text.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')

    write_text(name, text + '\n')
