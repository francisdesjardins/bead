"""The spec's version, as spec/spec.md states it: what each conformance file repeats as its specVersion."""
import os
import re

SPEC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'spec.md')


def spec_version():
    with open(SPEC, encoding='utf-8') as file:
        found = re.search(r'^\*\*Version: (\d+\.\d+\.\d+)\*\*', file.read(), re.MULTILINE)

    if found is None:
        raise SystemExit('spec/spec.md states no **Version: x.y.z**')

    return found.group(1)
