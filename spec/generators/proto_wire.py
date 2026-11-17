"""Protobuf's binary encoding, as its Encoding guide writes a record: the wire types, a varint, a tag,
a scalar's body and a length-delimited one, which make_validations.py and make_transcoding.py both
encode their messages with, and make_codecs.py reads Probe's records by."""
import struct

# the wire types of protobuf's Encoding guide, "Message Structure"
VARINT, I64, LEN, SGROUP, EGROUP, I32 = 0, 1, 2, 3, 4, 5


def varint(value):
    value &= (1 << 64) - 1
    out = bytearray()

    while True:
        byte = value & 0x7F
        value >>= 7

        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def tag(number, wire):
    return varint(number << 3 | wire)


def scalar_bytes(kind, value):
    """A scalar's record's body, and its wire type."""
    if kind in ('int32', 'int64', 'uint32', 'uint64') or kind.startswith('enum:'):
        return varint(value), VARINT
    if kind == 'bool':
        return varint(int(value)), VARINT
    if kind == 'sint32':
        return varint((value << 1) ^ (value >> 31)), VARINT
    if kind == 'sint64':
        return varint((value << 1) ^ (value >> 63)), VARINT
    if kind == 'fixed32':
        return struct.pack('<I', value), I32
    if kind == 'sfixed32':
        return struct.pack('<i', value), I32
    if kind == 'float':
        return struct.pack('<f', value), I32
    if kind == 'fixed64':
        return struct.pack('<Q', value), I64
    if kind == 'sfixed64':
        return struct.pack('<q', value), I64
    if kind == 'double':
        return struct.pack('<d', value), I64
    if kind == 'string':
        data = value.encode('utf-8')
        return varint(len(data)) + data, LEN
    if kind == 'bytes':
        return varint(len(value)) + value, LEN
    raise ValueError(kind)


def length_delimited(data):
    return varint(len(data)) + data


def f32(value):
    """The 32-bit float nearest a double, a tie to the even; OverflowError past the largest finite one."""
    return struct.unpack('<f', struct.pack('<f', value))[0]
