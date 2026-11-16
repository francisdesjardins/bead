"""What the generators share: the folder the conformance files sit in and the writer of each file, bytes
as the files write them, the steps of a case on the server's clock, the order of an entry's units, the
spec's codes, and the small searches and values more than one generator draws on."""
import json
import os

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
