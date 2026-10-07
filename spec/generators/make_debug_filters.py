"""Writes spec/debug-filters.json: what a filter reads as, which calls and envelopes it keeps, or why it is
refused, and what a filter given as a function does from event to event (spec/debugging.md, section 6;
decision 0013). The filter is read here a third time, beside the two sides, by the grammar's words."""
import json
import os
import re
import tokenize

from debugging_version import debugging_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

# a comma, and the six characters C's isspace reads as white space in the C locale (6.2)
SEPARATORS = frozenset(', \t\n\x0b\x0c\r')

# what each selector's values name, read in ASCII lower case: a type's short form names its word (6.3)
NAMES = {
    'd': {'rx': 'rx', 'tx': 'tx'},
    't': {'request': 'request', 'command': 'command', 'notification': 'notification',
          'r': 'request', 'c': 'command', 'n': 'notification'},
    'e': {kind: kind for kind in ('request', 'result', 'failure', 'notification', 'chunk', 'credit', 'cancel')},
}

LISTS = {'d': 'directions', 't': 'types', 'e': 'kinds'}


class Refused(Exception):
    def __init__(self, reason, written):
        super().__init__(reason)
        self.reason = reason
        self.written = written


def lower(text):
    """ASCII's letters in lower case, every other character as it is, as RFC 5234 reads a string."""
    return ''.join(chr(ord(character) + 32) if 'A' <= character <= 'Z' else character for character in text)


def words_of(text):
    words, word = [], ''

    for character in text:
        if character in SEPARATORS:
            words += [word] if word else []
            word = ''
        else:
            word += character

    return words + ([word] if word else [])


def parse(text):
    """The five lists a filter reads as (6.6), or Refused with the first word that does not hold (6.7)."""
    parsed = {'directions': [], 'types': [], 'kinds': [], 'include': [], 'exclude': []}

    for word in words_of(text):
        letter = lower(word[0])

        if len(word) >= 3 and letter in NAMES and word[1] == '(' and word[-1] == ')':
            inner = word[2:-1]

            if inner == '':
                raise Refused('selector empty', word)

            for value in inner.split('|'):
                if value == '':
                    raise Refused('value empty', word)
                if lower(value) not in NAMES[letter]:
                    raise Refused('names nothing', value)

                parsed[LISTS[letter]].append(NAMES[letter][lower(value)])
        elif '(' in word or ')' in word:
            raise Refused('holds a parenthesis', word)
        elif word.startswith('-'):
            parsed['exclude'].append(word[1:])
        else:
            parsed['include'].append(word)

    return parsed


def matches(pattern, name):
    """Whether a pattern matches a whole name: * any run, line terminators among them; an ASCII letter
    in either case; any other character itself alone, code point by code point (6.4)."""
    parts = lower(pattern).split('*')
    name = lower(name)

    if len(parts) == 1:
        return parts[0] == name

    first, *middle, last = parts

    if len(name) < len(first) + len(last) or not name.startswith(first) or not name.endswith(last):
        return False

    rest = name[len(first):len(name) - len(last)]

    for part in middle:
        found = rest.find(part)

        if found < 0:
            return False

        rest = rest[found + len(part):]

    return True


def keeps_call(parsed, call):
    return ((not parsed['directions'] or call['direction'] in parsed['directions'])
            and (not parsed['types'] or call['type'] in parsed['types'])
            and (not parsed['include'] or any(matches(pattern, call['procedureName']) for pattern in parsed['include']))
            and not any(matches(pattern, call['procedureName']) for pattern in parsed['exclude']))


def keeps_envelope(parsed, envelope):
    return ((not parsed['directions'] or envelope['direction'] in parsed['directions'])
            and (not parsed['kinds'] or envelope['kind'] in parsed['kinds']))


# ── The fixtures ────────────────────────────────────────────────────────────────────────────────

def call(direction, kind, name):
    return {'direction': direction, 'type': kind, 'procedureName': name}


CALLS = [
    call('tx', 'request', 'getStatus'),          # 0
    call('rx', 'request', 'getStatus'),          # 1
    call('rx', 'request', 'GetTime'),            # 2
    call('tx', 'command', 'ping'),               # 3
    call('rx', 'notification', 'news'),          # 4
    call('tx', 'request', 'a\rb'),               # 5: a carriage return, U+000D, within
    call('tx', 'request', 'a\u2028b'),          # 6: a line separator, U+2028, within
    call('rx', 'request', 'key'),                # 7
    call('rx', 'request', '\u212aey'),           # 8: the Kelvin sign, U+212A, which some platforms fold with k
    call('rx', 'request', '\u0130d'),            # 9: a capital I with a dot, U+0130, which some platforms lower to two
    call('rx', 'request', 'a\u0085b'),           # 10: a next line, U+0085, within, white space to some platforms
    call('rx', 'request', ''),                   # 11: the empty name
    call('rx', 'request', 'a.b'),                # 12
    call('rx', 'request', 'axb'),                # 13
    call('rx', 'request', 'caf\u00e9'),          # 14: a letter outside ASCII, U+00E9
    call('tx', 'request', 'a\nb'),               # 15: a line feed, U+000A, within, which a regular expression's . matches on no platform
]

ENVELOPES = [
    {'direction': 'tx', 'kind': 'request'},       # 0
    {'direction': 'rx', 'kind': 'result'},        # 1
    {'direction': 'rx', 'kind': 'failure'},       # 2
    {'direction': 'tx', 'kind': 'cancel'},        # 3
    {'direction': 'rx', 'kind': 'notification'},  # 4
    {'direction': 'tx', 'kind': 'chunk'},         # 5
    {'direction': 'rx', 'kind': 'credit'},        # 6
]

# ── The filters ─────────────────────────────────────────────────────────────────────────────────

# the units of spec/debugging.md each entry checks
GRAMMAR, SEPARATED, SELECTORS, PATTERNS, PASSING, READ_AS, REFUSED, FUNCTION = (
    '6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.7', '6.9')
SELECTOR_EMPTY, VALUE_EMPTY, NAMES_NOTHING, PARENTHESIS = '6.7.1', '6.7.2', '6.7.3', '6.7.4'

FILTERS = [
    ('an empty filter keeps every call and every envelope', [PASSING], ''),
    ('separators alone are an empty filter', [GRAMMAR, SEPARATED, PASSING], ' ,\t\n\x0b\x0c\r'),
    ('a comma and each of the six ASCII white spaces part two words',
     [GRAMMAR, SEPARATED, READ_AS], 'getStatus,ping news\tkey\nGetTime\x0baxb\x0ca.b\rcaf\u00e9'),
    ('a run of separators parts two words once', [GRAMMAR, SEPARATED], ', ping ,\t, news ,'),
    ('a next line, U+0085, parts no two words', [SEPARATED, READ_AS], 'a\u0085b'),
    ('a byte order mark, U+FEFF, parts no two words', [SEPARATED, READ_AS], 'getStatus\ufeffping'),
    ('a no-break space, U+00A0, parts no two words', [SEPARATED, READ_AS], 'getStatus\u00a0ping'),
    ('a line separator, U+2028, parts no two words', [SEPARATED, READ_AS], 'getStatus\u2028ping'),
    ('d(rx) keeps the calls and the envelopes that come in', [SELECTORS, PASSING], 'd(rx)'),
    ('a selector\'s letter and its values are read in either case', [GRAMMAR, SELECTORS], 'D(TX)'),
    ('d(rx|tx) keeps both directions', [GRAMMAR, SELECTORS], 'd(rx|tx)'),
    ('selectors of one letter add up', [SELECTORS, READ_AS], 'd(rx), D(tx)'),
    ('a value given twice is kept twice', [READ_AS], 't(r|request)'),
    ('t() takes the trace\'s words', [GRAMMAR, SELECTORS], 't(request|command)'),
    ('t() takes r, c and n as the short forms of the trace\'s words', [GRAMMAR, SELECTORS], 't(n|C)'),
    ('t() keeps types of call, and an envelope passes it whatever its kind', [SELECTORS, PASSING], 'T(Notification)'),
    ('e() keeps kinds of envelope by their names, and a call passes it whatever its type', [SELECTORS, PASSING], 'e(failure|RESULT)'),
    ('e() takes every kind of section 3.1', [GRAMMAR, SELECTORS], 'e(request|result|failure|notification|chunk|credit|cancel)'),
    ('a pattern keeps the calls whose name it matches, and an envelope passes it whatever its kind', [PATTERNS, PASSING], 'ping'),
    ('a pattern matches a whole name, an ASCII letter in either case', [PATTERNS], 'GETTIME, KEY'),
    ('* stands for any run of characters, none included', [PATTERNS], 'get*'),
    ('* alone keeps every name, the empty one among them', [PATTERNS], '*'),
    ('* crosses a carriage return, a line feed and a line separator', [PATTERNS], 'a*'),
    ('a point stands for itself', [PATTERNS], 'a.b'),
    ('an exclusion leaves out what it matches, and wins over a pattern', [PATTERNS, READ_AS], 'get* -getStatus'),
    ('an exclusion alone keeps every name but those it matches', [PATTERNS], '-g*'),
    ('- alone leaves out the empty name', [GRAMMAR, PATTERNS, READ_AS], '-'),
    ('a selector, a pattern and an exclusion together', [GRAMMAR, PASSING, READ_AS], ' d(rx),t(r|C)  get*, -getStatus\tping '),
    ('the Kelvin sign in a pattern matches itself alone', [PATTERNS], '\u212aEY'),
    ('k in a pattern matches no Kelvin sign', [PATTERNS], 'Key'),
    ('a capital I with a dot in a pattern matches itself alone', [PATTERNS], '\u0130D'),
    ('i in a pattern matches no capital I with a dot', [PATTERNS], 'Id'),
    ('a letter outside ASCII matches itself in its own case alone', [PATTERNS], 'CAF\u00c9, CAF\u00e9'),
    ('a pattern within a word of separators outside ASCII matches that whole word', [SEPARATED, PATTERNS], 'A\u0085B'),
    # what a side refuses, and what it names
    ('d() is refused, an empty selector', [REFUSED, SELECTOR_EMPTY], 'd()'),
    ('e() is refused, an empty selector, in either case', [REFUSED, SELECTOR_EMPTY], 'ping E()'),
    ('a value left empty is refused', [REFUSED, VALUE_EMPTY], 'd(rx|)'),
    ('a value left empty first is refused', [REFUSED, VALUE_EMPTY], 't(|r)'),
    ('a direction that is none is refused, named as it was written', [REFUSED, NAMES_NOTHING], 'd(UP)'),
    ('d(rx)(tx) is one selector, whose one value names nothing', [REFUSED, NAMES_NOTHING], 'd(rx)(tx)'),
    ('a kind spelled with the Kelvin sign names nothing', [GRAMMAR, REFUSED, NAMES_NOTHING], 'e(chun\u212a)'),
    ('a kind spelled with a capital I with a dot names nothing', [GRAMMAR, REFUSED, NAMES_NOTHING], 'e(not\u0130fication)'),
    ('a type the trace does not name is refused', [REFUSED, NAMES_NOTHING], 't(constructor)'),
    ('a value holding a quote is refused, named as it was written', [REFUSED, NAMES_NOTHING], 'd("rx")'),
    ('a value holding a backslash is refused, named as it was written', [REFUSED, NAMES_NOTHING], 't(r\\n)'),
    ('a value that names nothing is refused before an empty one after it', [REFUSED, NAMES_NOTHING], 'd(up|)'),
    ('d(rx,tx) is two words, each holding a parenthesis', [GRAMMAR, REFUSED, PARENTHESIS], 'd(rx,tx)'),
    ('a parenthesis alone is refused', [REFUSED, PARENTHESIS], 'ping ('),
    ('a word holding a parenthesis that is no selector is refused', [REFUSED, PARENTHESIS], 'x(y)'),
    ('an exclusion holding a selector is refused', [REFUSED, PARENTHESIS], '-d(rx)'),
    ('a selector of another letter is refused, a word holding a parenthesis', [REFUSED, PARENTHESIS], 'p(rx)'),
    ('the first word that does not hold is the one refused', [REFUSED, NAMES_NOTHING], 'd(up) t() x('),
]


def entry(name, clauses, text):
    try:
        parsed = parse(text)
    except Refused as refused:
        return {'name': name, 'clauses': clauses, 'filter': text,
                'refused': {'reason': refused.reason, 'written': refused.written}}

    return {'name': name, 'clauses': clauses, 'filter': text, 'parsed': parsed,
            'keeps': {'calls': [index for index, each in enumerate(CALLS) if keeps_call(parsed, each)],
                      'envelopes': [index for index, each in enumerate(ENVELOPES) if keeps_envelope(parsed, each)]}}


# ── A filter given as a function ────────────────────────────────────────────────────────────────

def gives(text):
    return {'gives': text}


def made(listener_made):
    return {'made': listener_made}


THROWS = {'throws': True}


class Source:
    """A function's filter, played as a side plays it (6.9): asked as its listener is made, and at
    each event; the last filter that held stays when the next does not, or the function throws."""

    def __init__(self, listener):
        self.listener = listener
        self.giving = None
        self.held = None

    def ask(self):
        if self.giving is THROWS:
            raise Refused('throws', None)

        # none is no filter, which keeps every one, as an empty filter does
        return parse('' if self.giving is None else self.giving)

    def step(self, step):
        if 'gives' in step or 'throws' in step:
            self.giving = step['gives'] if 'gives' in step else THROWS
            return step

        if 'made' in step:
            try:
                self.held = self.ask()
            except Refused:
                return made(False)

            return made(True)

        try:
            self.held = self.ask()
        except Refused:
            pass

        keeps = keeps_call if self.listener == 'call' else keeps_envelope
        fixtures = CALLS if self.listener == 'call' else ENVELOPES

        return {'event': step['event'], 'heard': keeps(self.held, fixtures[step['event']])}


def event(index):
    return {'event': index}


SOURCES = [
    ('a function\'s first filter that does not hold makes no listener', [FUNCTION], 'call',
     [gives('d(up)'), {'made': None}]),
    ('a function that throws as its listener is made makes none', [FUNCTION], 'call', [THROWS, {'made': None}]),
    ('a function is asked at each event, and a filter that stops holding leaves the last that held', [FUNCTION], 'call',
     [gives('d(rx)'), {'made': None}, event(1), event(0), gives('d(up)'), event(1), event(0),
      gives('d(tx)'), event(0), event(1)]),
    ('a function that throws leaves the last filter that held, until it gives one again', [FUNCTION], 'call',
     [gives('t(c)'), {'made': None}, event(3), event(1), THROWS, event(3), event(1), gives(''), event(1), event(3)]),
    ('a function\'s filter of envelopes is asked at each event alike', [FUNCTION], 'envelope',
     [gives('e(failure)'), {'made': None}, event(2), event(1), gives('e(fail)'), event(2), event(1),
      gives('d(tx)'), event(0), event(2)]),
    ('a function that gives none keeps every event, as an empty filter does, from its first on', [PASSING, FUNCTION], 'call',
     [gives(None), {'made': None}, event(0), event(4), gives('d(rx)'), event(0), gives(None), event(0), event(11)]),
]


def source(name, clauses, listener, steps):
    played = Source(listener)
    return {'name': name, 'clauses': clauses, 'listener': listener, 'steps': [played.step(step) for step in steps]}


document = {
    '$schema': 'schemas/debug-filters.schema.json',
    '$comment': [
        "Bead's debug filters: what a filter reads as, which calls and envelopes it keeps, or why a side refuses it, and what a filter given as a function does from event to event (spec/debugging.md, section 6; decision 0013).",
        'calls are the fixtures a call\'s filter is asked of: a trace\'s event, by its direction, its type and its procedure\'s name. envelopes are those an envelope\'s filter is asked of: a router\'s event, by its direction and its kind, named as section 3.1 of spec.md names it, in lower case. An entry names a fixture by its index.',
        'filter is a filter as written. parsed is what it reads as (6.6): its directions, its types and its kinds, by the grammar\'s names, and include, its patterns, and exclude, its exclusions without their -, as written, each in the order of its words. keeps lists the calls a call\'s listener given the filter hears, and the envelopes an envelope\'s listener hears, in their order.',
        'refused, in place of parsed and keeps, is why a side refuses the filter (6.7): reason, the first word that does not hold, and written, the word or the value it names, as it was written. The words of a refusal are each side\'s own, and stay with its tests.',
        'sources are filters given as functions (6.9). listener says whose listener the function filters, a call\'s or an envelope\'s. A step gives a filter, which the function gives from then on, or null, none, which keeps every event; throws, from then on the function throws; made, the listener is made with the function, which is asked then, and true or false says whether it is made; event, an event of that fixture goes through the listener, which asks the function again, and heard says whether the listener heard it.',
        'clauses are the units of spec/debugging.md an entry checks: a clause, 6.7; a row of its table, counted from 1, 6.7.3.',
        'Every character outside printable ASCII is written as its JSON escape.',
    ],
    'debuggingVersion': debugging_version(),
    'calls': CALLS,
    'envelopes': ENVELOPES,
    'filters': [entry(*each) for each in FILTERS],
    'sources': [source(*each) for each in SOURCES],
}

# a source's listener is made, or not, once, before any event, and never after one that was not made
for each in document['sources']:
    steps = each['steps']
    made_at = [index for index, step in enumerate(steps) if 'made' in step]
    assert len(made_at) == 1 and not any('event' in step for step in steps[:made_at[0]]), each['name']
    assert steps[made_at[0]]['made'] or made_at[0] == len(steps) - 1, each['name']

# ! an entry that names a code point holds it, and every string here is written in ASCII, a
# character outside it as its escape: an editor that drops an invisible character leaves the name
# saying what the data no longer holds
for name, _clauses, text in FILTERS:
    for code_point in re.findall(r'U\+([0-9A-F]{4,6})', name):
        assert chr(int(code_point, 16)) in text, name

# the fixtures whose comments name a character, by their index
for index, code_point in ((5, 0x0D), (6, 0x2028), (8, 0x212A), (9, 0x0130), (10, 0x85), (14, 0xE9), (15, 0x0A)):
    assert chr(code_point) in CALLS[index]['procedureName'], index

# a string's text as written, not its value: '\u2028' is ASCII written, U+2028 once read; the literal
# text of an f-string, and of a t-string, is a token of its own (Python 3.12, 3.14)
WRITTEN = {tokenize.STRING} | {getattr(tokenize, kind) for kind in ('FSTRING_MIDDLE', 'TSTRING_MIDDLE')
                               if hasattr(tokenize, kind)}
with tokenize.open(__file__) as generator:
    for token in tokenize.generate_tokens(generator.readline):
        assert token.type not in WRITTEN or token.string.isascii(), token.start

with open(ROOT + 'debug-filters.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=True, indent=2)
    file.write('\n')

print(len(FILTERS), 'debug filters and', len(SOURCES), 'given as functions')
