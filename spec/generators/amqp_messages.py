"""The profile of spec 15.35 and the count of spec 15.37: the bytes of an AMQP 1.0 message that carries a
parcel, and the largest payload a message to a topic carries within a bound, which spec/vectors.json's
amqpMessages and amqpPublishBounds and the bounds of spec/transports.json's cases over AMQP 1.0 all
read from here, so the three cannot disagree. Its writer is the profile's reference, which every side
is held to by amqpMessages."""

# the largest value of a uint, the largest payload a vbin32 holds, and the bound of a sender's ATTACH
# that names no max-message-size (AMQP 1.0 Types §1.6.10, §1.6.19; spec 15.37)
LARGEST_UINT = 4_294_967_295
# a life's header counted whatever the message: its descriptor 3, a list8's 3, its two nulls 2 and a
# uint of 5 (spec 15.37)
LIFE_BYTES = 13
# an adapter's maximumMessageSize, the largest message whose payload it takes, unless its application
# gives another (spec 15.37)
MAXIMUM_MESSAGE_SIZE = 16_777_216

# the described types of the sections the profile writes (AMQP 1.0 Messaging §3.2.1, §3.2.4, §3.2.6)
HEADER, PROPERTIES, DATA = 0x70, 0x73, 0x75
NULL = b'\x40'


def described(code, body):
    """A described type of a small-ulong descriptor: 0x00, 0x53 and its code, then its value."""
    return bytes([0x00, 0x53, code]) + body


def described_list(fields):
    """A list of its fields, list8 where its size and count fit a byte, list32 otherwise."""
    body = b''.join(fields)

    if len(body) + 1 <= 0xFF and len(fields) <= 0xFF:
        return bytes([0xC0, len(body) + 1, len(fields)]) + body

    return b'\xd0' + (len(body) + 4).to_bytes(4, 'big') + len(fields).to_bytes(4, 'big') + body


def uint(value):
    """A uint in the smallest of its encodings: uint0, smalluint or uint."""
    assert 0 <= value <= LARGEST_UINT

    if value == 0:
        return b'\x43'

    if value <= 0xFF:
        return bytes([0x52, value])

    return b'\x70' + value.to_bytes(4, 'big')


def variable(data, small, large):
    """A variable-width value, of its one-byte length where it fits, of its four-byte length otherwise."""
    if len(data) <= 0xFF:
        return bytes([small, len(data)]) + data

    return bytes([large]) + len(data).to_bytes(4, 'big') + data


def encode(to, payload, ttl=None):
    """A message of the profile: a header only where a life is asked, its ttl alone, in milliseconds;
    properties whose to alone is set, the fields before it null; one Data section, the payload."""
    header = b'' if ttl is None else described(HEADER, described_list([NULL, NULL, uint(ttl)]))
    properties = described(PROPERTIES, described_list([NULL, NULL, variable(to.encode('utf-8'), 0xA1, 0xB1)]))
    return header + properties + described(DATA, variable(payload, 0xA0, 0xB0))


def width(payload):
    """w(N): the bytes of a Data section's binary before its payload, vbin8 under 256, vbin32 otherwise."""
    return 2 if payload < 256 else 5


def message_bytes(address_bytes, payload, *, life):
    """S: a life's header, the properties of an address of that many bytes, and the Data section. An
    address is at most 207 bytes, so its str8 and its properties' list8 always fit."""
    assert address_bytes <= 207
    return (LIFE_BYTES if life else 0) + 10 + address_bytes + 3 + width(payload) + payload


def address_of(root, topic):
    """The address a participant writes a topic to: the topic exchange named its root (spec 15.32)."""
    return f'/exchanges/{root}/{topic}'


def largest_payload(address, maximum):
    """The largest payload of a message to that address within that bound, a life counted whatever the
    message, at most 4,294,967,295, or None where an empty one does not fit: found by a search, since
    w grows with N."""
    address_bytes = len(address.encode('utf-8'))

    def fits(payload):
        return message_bytes(address_bytes, payload, life=True) <= maximum

    if not fits(0):
        return None

    low, high = 0, LARGEST_UINT

    while low < high:
        middle = (low + high + 1) // 2
        low, high = (middle, high) if fits(middle) else (low, middle - 1)

    return low


def receive_bound(root, participant, maximum=MAXIMUM_MESSAGE_SIZE):
    """A participant's receive bound: the largest payload of a message to its inbox within its own
    maximumMessageSize, as its publisher writes it, a life counted (spec 15.37)."""
    return largest_payload(address_of(root, f'{root}.i.{participant}'), maximum)


# the counts of 15.37, and its examples
assert receive_bound('bead', 'server') == 16_777_156
assert largest_payload(address_of('bead', 'bead.i.peer'), 4_096) == 4_038
assert largest_payload(address_of('bead', 'bead.i.server'), 4_096) == 4_036
assert len(address_of('r' * 64, 'r' * 64 + '.i.' + 't' * 64)) == 207

# rows AMQPNetLite 2.5.4's Message.Encode() wrote, each byte the writer's and each count S's: each
# width of a ttl, a payload at vbin8's edge and past it, and the longest address
for _to, _payload, _ttl, _bytes in [
    ('/exchanges/bead/bead.i.server', 0, None,
     '005373c022034040a11d2f65786368616e6765732f626561642f626561642e692e736572766572005375a000'),
    ('/exchanges/bead/bead.i.server', 0, 0,
     '005370c00403404043005373c022034040a11d2f65786368616e6765732f626561642f626561642e692e736572766572005375a000'),
    ('/exchanges/bead/bead.i.server', 0, 255,
     '005370c00503404052ff005373c022034040a11d2f65786368616e6765732f626561642f626561642e692e736572766572005375a000'),
    ('/exchanges/bead/bead.i.server', 0, 256,
     '005370c0080340407000000100005373c022034040a11d2f65786368616e6765732f626561642f626561642e692e736572766572005375a000'),
]:
    assert encode(_to, b'\x5a' * _payload, _ttl).hex() == _bytes

for _payload, _head in [(255, '005375a0ff'), (256, '005375b000000100')]:
    _encoded = encode('/exchanges/bead/bead.s.interop-both', b'\x5a' * _payload, 1_234)
    assert _encoded[:-_payload].hex().endswith(_head)
    assert len(_encoded) == message_bytes(35, _payload, life=True)

_longest = address_of('r' * 64, 'r' * 64 + '.i.' + 't' * 64)
assert encode(_longest, b'', LARGEST_UINT)[:16].hex() == '005370c00803404070ffffffff005373'
assert len(encode(_longest, b'\x5a' * 4_096, LARGEST_UINT)) == message_bytes(207, 4_096, life=True)
