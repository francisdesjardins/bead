"""A JWS as the conformance files carry one (RFC 7515): base64url without padding, JSON as a token
carries it, and a token signed with HMAC-SHA256, which make_vectors.py, make_conversations.py and
make_transports.py each sign their tokens by."""
import base64
import hashlib
import hmac
import json


def base64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def unbase64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def compact(value):
    """JSON as a token carries it: no space, its members in the order written, ASCII escaped."""
    return json.dumps(value, separators=(',', ':')).encode('ascii')


def part(value):
    """A header or a claims set, from a JSON value or from its bytes as given."""
    return base64url(value if isinstance(value, bytes) else compact(value))


def signed(header, claims, secret):
    """A JWS in its compact serialization, signed with HMAC-SHA256 (RFC 7518 §3.2) by Python's own hmac."""
    signing_input = part(header) + '.' + part(claims)
    return signing_input + '.' + base64url(hmac.new(secret, signing_input.encode('ascii'), hashlib.sha256).digest())
