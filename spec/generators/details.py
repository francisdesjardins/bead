"""The form of PAYLOAD_INVALID's detail (spec 18.3, 18.6): a violation's members, RFC 8785's canonical
form of a value (17.7), and the writer of a detail's lines under its bound, which make_validations.py
and make_conversations.py share, so that a verdict's detail and a conversation's are written alike."""
import json
from decimal import Decimal


# ── RFC 8785, 17.7 ──────────────────────────────────────────────────────────────────────────────


def es(value):
    """ECMAScript's Number::toString of a finite double: what RFC 8785 3.2.2.3 writes a number as, and
    what 18.8.6 writes a float or a double as."""
    if value == 0:
        return '0'

    if value < 0:
        return '-' + es(-value)

    _, digits, exponent = Decimal(repr(value)).as_tuple()
    digits = ''.join(map(str, digits)).lstrip('0')
    stripped = digits.rstrip('0')
    exponent += len(digits) - len(stripped)
    digits = stripped
    k, n = len(digits), exponent + len(digits)

    if k <= n <= 21:
        return digits + '0' * (n - k)

    if 0 < n <= 21:
        return digits[:n] + '.' + digits[n:]

    if -6 < n <= 0:
        return '0.' + '0' * -n + digits

    return (digits if k == 1 else digits[0] + '.' + digits[1:]) + 'e' + ('+' if n - 1 >= 0 else '-') + str(abs(n - 1))


def canonical(value):
    """A value's canonical form (17.7): its members sorted by their UTF-16 code units, a number as
    ECMAScript writes its double, a string as JSON.stringify writes a well-formed one."""
    if value is None:
        return 'null'

    if value is True:
        return 'true'

    if value is False:
        return 'false'

    if isinstance(value, (int, float)):
        return es(float(value))

    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)

    if isinstance(value, list):
        return '[' + ','.join(canonical(item) for item in value) + ']'

    members = sorted(value.items(), key=lambda member: member[0].encode('utf-16-be'))
    return '{' + ','.join(json.dumps(name, ensure_ascii=False) + ':' + canonical(item) for name, item in members) + '}'


def utf8(text):
    return len(text.encode('utf-8'))




def violation(path, rule_id, bounds, message, for_key=False):
    """A violation's members (18.3), in the order RFC 8785 sorts them: bounds, fieldPath, forKey,
    message, ruleId."""
    found = {}

    if bounds:
        found['bounds'] = bounds

    if path:
        found['fieldPath'] = path

    if for_key:
        found['forKey'] = True

    if message:
        found['message'] = message

    found['ruleId'] = rule_id
    return found


# ── The detail, 18.6 and 18.7 ───────────────────────────────────────────────────────────────────

# the largest count a closing line writes, the largest integer an I-JSON number holds exactly (RFC 7493
# §2.2), and the closing line at its longest, {"more":N} with N at it, and the line feed before it
LARGEST_COUNT = 2 ** 53 - 1
KEPT = 1 + len('{"more":' + str(LARGEST_COUNT) + '}')
assert KEPT == 26


def written(found):
    """A violation's members as a writer writes them (18.6): none empty, a fieldPath or a message of '',
    a bounds of {}, a forKey but true."""
    return {key: member for key, member in found.items()
            if key == 'ruleId' or (member is True if key == 'forKey' else member not in ('', {}, None))}


def forms(found):
    """A violation's line, whole, then without its message, then without its bounds too (18.6)."""
    found = written(found)
    whole = canonical(found)
    short = canonical({key: member for key, member in found.items() if key != 'message'})
    shortest = canonical({key: member for key, member in found.items() if key not in ('message', 'bounds')})
    return list(dict.fromkeys([whole, short, shortest]))


def kept(violations, maximum):
    """What a judging holds under a bound: the violations whose line, in one of its forms, holds with
    26 bytes kept, in their order, the first that holds in none ending them; and the lines written."""
    lines, size = [], 0

    for count, found in enumerate(violations):
        line = next((each for each in forms(found) if size + (1 if lines else 0) + utf8(each) + KEPT <= maximum), None)

        if line is None:
            return count, lines

        size += (1 if lines else 0) + utf8(line)
        lines.append(line)

    return len(violations), lines


def judged(violations, *, maximum=None, fail_fast=False):
    """What a validator gives (18.2, 18.6): the violations it holds, the count of the rest, and whether
    it stopped at its first."""
    if fail_fast:
        violations = violations[:1]

    holds = len(violations) if maximum is None else kept(violations, maximum)[0]
    return {'violations': violations[:holds], 'more': len(violations) - holds, 'stopped': fail_fast and bool(violations)}


def detail_of(result, maximum):
    """The detail 18.6 writes of what a validator gave, under a bound."""
    count, lines = kept(result['violations'], maximum)
    left = min(result['more'] + len(result['violations']) - count, LARGEST_COUNT)
    closing = canonical({'stopped': True} if result['stopped'] else {'more': left})

    # the lines, each with the line feed after it, then the closing line
    if sum(utf8(line) + 1 for line in lines) + utf8(closing) > maximum:
        return ''

    return '\n'.join([*lines, closing])
