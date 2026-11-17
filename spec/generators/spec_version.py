"""The versions spec/'s documents state: spec/spec.md's, what each conformance file repeats as its
specVersion; spec/debugging.md's, what each of its conformance files repeats as its debuggingVersion
(decision 0013); and spec/transcoding.md's, what its conformance file repeats as its transcodingVersion
(decision 0037)."""
import os
import re

# the documents sit one folder up from their generators
SPEC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')


def stated_version(document):
    """The version a document of spec/ states on its own line, as **Version: x.y.z**."""
    with open(SPEC + document, encoding='utf-8') as file:
        found = re.search(r'^\*\*Version: (\d+\.\d+\.\d+)\*\*', file.read(), re.MULTILINE)

    if found is None:
        raise SystemExit(f'spec/{document} states no **Version: x.y.z**')

    return found.group(1)


def spec_version():
    return stated_version('spec.md')


def debugging_version():
    return stated_version('debugging.md')


def transcoding_version():
    return stated_version('transcoding.md')
