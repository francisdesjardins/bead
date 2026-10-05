"""The companion's version, as spec/debugging.md states it: what each of its conformance files repeats as
its debuggingVersion (decision 0013)."""
import os
import re

DEBUGGING = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'debugging.md')


def debugging_version():
    with open(DEBUGGING, encoding='utf-8') as file:
        found = re.search(r'^\*\*Version: (\d+\.\d+\.\d+)\*\*', file.read(), re.MULTILINE)

    if found is None:
        raise SystemExit('spec/debugging.md states no **Version: x.y.z**')

    return found.group(1)
