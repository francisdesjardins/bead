"""The companion's version, as spec/transcoding.md states it: what its conformance file repeats as its
transcodingVersion (decision 0037)."""
import os
import re

TRANSCODING = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'transcoding.md')


def transcoding_version():
    with open(TRANSCODING, encoding='utf-8') as file:
        found = re.search(r'^\*\*Version: (\d+\.\d+\.\d+)\*\*', file.read(), re.MULTILINE)

    if found is None:
        raise SystemExit('spec/transcoding.md states no **Version: x.y.z**')

    return found.group(1)
