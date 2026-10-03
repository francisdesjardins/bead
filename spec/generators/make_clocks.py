"""Writes spec/clocks.json: what every side's test clock does when a case advances it, so that advance
means one thing in every conformance file (decision 0011)."""
import json
import os

from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

WALL_CLOCK = '2026-01-01T00:00:00Z'


def arm(timer, due, *, period=None, then=None):
    """A timer armed now, due in `due` milliseconds, every `period` after that when given; `then` is the
    timer its callback arms, counted from the callback's own reading."""
    return {'arm': {'timer': timer, 'due': due, **({'period': period} if period else {}),
                    **({'then': then['arm']} if then else {})}}


def fired(*timers):
    """The timers that fired since the last check, in their order, each with the monotonic reading its
    callback read, in milliseconds since the case began."""
    return {'fired': [{'timer': timer, 'at': at} for timer, at in timers]}


def readings(*, monotonic=None, wall=None):
    return {'readings': {**({'monotonic': monotonic} if monotonic is not None else {}),
                         **({'wall': wall} if wall is not None else {})}}


cases = [
    ('a timer fires at its due, and its callback reads it', [
        arm('a', 1000), {'advance': 3000}, fired(('a', 1000)), readings(monotonic=3000)]),
    ('two timers chained in one advance each fire at their own due', [
        arm('a', 1000, then=arm('b', 1000)), {'advance': 3000}, fired(('a', 1000), ('b', 2000)),
        readings(monotonic=3000)]),
    ('a periodic timer fires once for each period crossed, each at its own due', [
        arm('p', 1000, period=1000), {'advance': 3500}, fired(('p', 1000), ('p', 2000), ('p', 3000)),
        readings(monotonic=3500)]),
    ('timers due at once fire in the order they were armed', [
        arm('a', 1000), arm('b', 1000), {'advance': 1000}, fired(('a', 1000), ('b', 1000))]),
    ('a timer due past an advance waits for the next one', [
        arm('a', 2000), {'advance': 1999}, fired(), {'advance': 1}, fired(('a', 2000))]),
    ('the wall clock starts where the file says, and moves with the monotonic one', [
        readings(monotonic=0, wall='2026-01-01T00:00:00.000Z'), {'advance': 1500},
        readings(monotonic=1500, wall='2026-01-01T00:00:01.500Z')]),
    ('the wall clock moves alone, back or forward, and moves no timer', [
        arm('a', 1000), {'wall': -3_600_000}, readings(monotonic=0, wall='2025-12-31T23:00:00.000Z'),
        {'wall': 7_200_000}, readings(monotonic=0, wall='2026-01-01T01:00:00.000Z'),
        fired(), {'advance': 1000}, fired(('a', 1000)), readings(wall='2026-01-01T01:00:01.000Z')]),
]

document = {
    '$schema': 'schemas/clocks.schema.json',
    '$comment': [
        "Bead's clock cases: what every side's test clock does when a case advances it, so that advance means one thing in every conformance file (decision 0011). A side plays them on the test clock its harnesses give the side under test, with nothing else running on it.",
        'arm arms a timer now, named timer, due in due milliseconds, every period after that when given; its callback notes its firing and its monotonic reading, then arms then, when given, counted from that reading.',
        "advance steps the clock: it settles the side, takes the earliest timer due within its milliseconds, sets both readings to that due, fires it, settles, and so on; then it sets both readings to the advance's end. A callback reads its own due, a periodic timer fires once for each period crossed, each at its own due, and timers due at once fire in the order they were armed.",
        'fired is the list of the timers that fired since the case began or since the last fired, in their order, each with the monotonic reading its callback read, in milliseconds since the case began.',
        'wall moves the wall clock alone, forward or back, in milliseconds, and moves no timer. readings checks the monotonic reading, in milliseconds since the case began, and the wall one, an RFC 3339 instant in UTC.',
        'wallClock is where the wall clock starts.',
    ],
    'specVersion': spec_version(),
    'wallClock': WALL_CLOCK,
    'cases': [{'name': name, 'steps': steps} for name, steps in cases],
}

with open(ROOT + 'clocks.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(cases), 'clock cases')
