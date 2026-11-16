"""What every generator shares: the folder the conformance files sit in, and the writer of each file it
writes there."""
import json
import os

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')


def write_text(name, text):
    """A file of spec/ written whole, in UTF-8, each line ended by a line feed."""
    with open(ROOT + name, 'w', encoding='utf-8', newline='\n') as file:
        file.write(text)


def write_json(name, document, *, ensure_ascii=False, line_separators_escaped=False):
    """A conformance file: its document as JSON, two spaces to a level, then a line feed. A character
    outside ASCII is written as it is, or as its escape where ensure_ascii is set; U+2028 and U+2029
    alone are escaped where line_separators_escaped is."""
    text = json.dumps(document, ensure_ascii=ensure_ascii, indent=2)

    if line_separators_escaped:
        text = text.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')

    write_text(name, text + '\n')
