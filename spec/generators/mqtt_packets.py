"""The count of spec 15.30: the bytes of an MQTT 5 PUBLISH, and the largest payload a message to a topic
carries within a Maximum Packet Size, which spec/vectors.json's mqttPublishBounds and the bounds of
spec/transports.json's cases over MQTT 5 both read from here, so the two files cannot disagree."""

# the largest Remaining Length a Variable Byte Integer holds, and the largest packet it makes, the
# bound of a CONNACK that names none (MQTT 5.0 §1.5.5, §2.1.4)
LARGEST_REMAINING = 268_435_455
LARGEST_PACKET = 1 + 4 + LARGEST_REMAINING
# a Message Expiry Interval: its identifier and its Four Byte Integer (MQTT 5.0 §3.3.2.3.3)
EXPIRY_BYTES = 5
# a participant's maximumPacketSize, its CONNECT's Maximum Packet Size, unless its application gives
# another (spec 15.30)
MAXIMUM_PACKET_SIZE = 16_777_216

assert LARGEST_PACKET == 268_435_460


def width(value):
    """The bytes of a Variable Byte Integer of that value."""
    return 1 if value < 128 else 2 if value < 16_384 else 3 if value < 2_097_152 else 4


def remaining_length(topic_bytes, payload, *, qos, expiry):
    """R: the topic's length and bytes, the packet identifier at QoS 1, the properties' length and a
    Message Expiry Interval where there is one, then the payload."""
    properties = EXPIRY_BYTES if expiry else 0
    return 2 + topic_bytes + (2 if qos else 0) + width(properties) + properties + payload


def publish_bytes(topic_bytes, payload, *, qos, expiry):
    """S: the fixed header's byte, R's own bytes, and R."""
    remaining = remaining_length(topic_bytes, payload, qos=qos, expiry=expiry)
    return 1 + width(remaining) + remaining


def largest_payload(topic, maximum, *, qos=1, expiry=True):
    """The largest payload of a PUBLISH to that topic within that bound, or None where an empty one
    does not fit: found by a search, since S grows with N and v(R) with it, so no overhead is fixed."""
    topic_bytes = len(topic.encode('utf-8'))

    def fits(payload):
        return (publish_bytes(topic_bytes, payload, qos=qos, expiry=expiry) <= maximum
                and remaining_length(topic_bytes, payload, qos=qos, expiry=expiry) <= LARGEST_REMAINING)

    if not fits(0):
        return None

    low, high = 0, LARGEST_REMAINING

    while low < high:
        middle = (low + high + 1) // 2
        low, high = (middle, high) if fits(middle) else (low, middle - 1)

    return low


def receive_bound(topic, maximum=MAXIMUM_PACKET_SIZE):
    """A participant's receive bound: the largest payload of a message to its inbox within its own
    Maximum Packet Size, at QoS 1 and with a life, whatever the message (spec 15.30)."""
    return largest_payload(topic, maximum)


assert receive_bound('bead/i/server') == 16_777_188
assert largest_payload('bead/i/peer', 4_096) == 4_072
