import { expect, test } from '@playwright/test';
import {
  isTie,
  parseTemplate,
  rawPathOf,
  routeIndexOf,
  templateOf,
  variablesOf,
  type IRawPath,
} from '../templates';

// helpers

/** `path` read raw, for a path the test knows matches some route. */
const pathOf = (path: string): IRawPath => {
  const raw = rawPathOf(path);

  if (raw === undefined) {
    throw new Error(`${path} matches no route`);
  }

  return raw;
};

/** The route of `templates` that answers `path`, and its variables. */
const answerOf = (templates: readonly string[], path: string) => {
  const parsed = templates.map(templateOf);
  const raw = rawPathOf(path);
  const index = raw === undefined ? undefined : routeIndexOf(parsed, raw);
  const template = index === undefined ? undefined : parsed[index];

  return {
    index,
    variables:
      template === undefined || raw === undefined
        ? undefined
        : variablesOf(template, raw).variables,
  };
};

// tests

test('parses a template as http.proto’s grammar states it, and refuses any other', () => {
  const { template } = parseTemplate('/v1/{book.name=shelves/*/books/**}:archive');

  expect(template?.segments).toEqual([
    { kind: 'literal', text: 'v1' },
    { kind: 'literal', text: 'shelves' },
    { kind: 'star' },
    { kind: 'literal', text: 'books' },
    { kind: 'stars' },
  ]);
  expect(template?.variables).toEqual([
    { end: 5, fieldPath: 'book.name', isMultiSegment: true, start: 1 },
  ]);
  expect(template?.verb).toBe('archive');
  expect(parseTemplate('/v1/{name}').template?.variables).toEqual([
    { end: 2, fieldPath: 'name', isMultiSegment: false, start: 1 },
  ]);

  expect(parseTemplate('v1').reason).toBe('a template that does not begin with /');
  expect(parseTemplate('/v1/**/x').reason).toBe('a ** that is not its last segment');
  expect(parseTemplate('/v1/{a={b}}').reason).toBe('a variable within a variable');
  expect(parseTemplate('/v1/{a=*').reason).toBe('a variable that does not close');
  expect(parseTemplate('/v1/a%20b').reason).toBe('a literal that is no segment');
  expect(parseTemplate('/v1//b').reason).toBe('a literal that is no segment');
  expect(parseTemplate('/v1:').reason).toBe('a verb that is no literal');
  expect(() => {
    return templateOf('/v1/{');
  }).toThrow('/v1/{ is no template');

  expect(isTie(templateOf('/v1/{a}/x'), templateOf('/v1/{b=*}/x'))).toBe(true);
  expect(isTie(templateOf('/v1/{a=*}'), templateOf('/v1/{a=**}'))).toBe(false);
  expect(isTie(templateOf('/v1/{a}:x'), templateOf('/v1/{a}:y'))).toBe(false);
});

test('matches a raw path, a single segment decoded whole and a multi-segment one but its %2F', () => {
  expect(answerOf(['/v1/books/{name}'], '/v1/books/a%2Fb%20c')).toEqual({
    index: 0,
    variables: { name: 'a/b c' },
  });
  expect(answerOf(['/v1/books/{name}'], '/v1/books/caf%C3%A9+x')).toEqual({
    index: 0,
    variables: { name: 'café+x' },
  });
  expect(answerOf(['/v1/{name=shelves/*/books/*}'], '/v1/shelves/a%2Fb/books/%2f%41')).toEqual({
    index: 0,
    variables: { name: 'shelves/a%2Fb/books/%2fA' },
  });
  expect(answerOf(['/v1/{name=**}'], '/v1')).toEqual({ index: 0, variables: { name: '' } });

  // a literal its segment's text exactly, raw and case-sensitive
  expect(answerOf(['/api/Hello/sayHello'], '/api/hello/sayHello').index).toBeUndefined();
  expect(answerOf(['/v1/books'], '/v1/bo%6Fks').index).toBeUndefined();

  const template = templateOf('/v1/books/{name}');

  expect(variablesOf(template, pathOf('/v1/books/%ZZ')).reason).toBe(
    'a % that two hexadecimal digits do not follow'
  );
  expect(variablesOf(template, pathOf('/v1/books/%C3%28')).reason).toBe(
    'a value whose bytes are not UTF-8'
  );
});

test('matches no path with an empty or a dot segment', () => {
  for (const path of [
    '/v1/books/..',
    '/v1/books/.',
    '/v1/books/%2E%2e',
    '/v1/books/%2e',
    '/v1/books/',
    '/v1//books',
    '/',
    'v1/books',
  ]) {
    expect(rawPathOf(path), path).toBeUndefined();
  }

  expect(rawPathOf('/v1/books/...')).toEqual({ segments: ['v1', 'books', '...'] });
});

test('answers by a literal before a star, a star before a double star, and a route that ends before a double star of none', () => {
  expect(answerOf(['/v1/books/{name}', '/v1/books/special'], '/v1/books/special').index).toBe(1);
  expect(answerOf(['/v1/books/{name}', '/v1/books/special'], '/v1/books/other').index).toBe(0);
  expect(answerOf(['/v1/{name=things/**}', '/v1/things/{id}'], '/v1/things/a')).toEqual({
    index: 1,
    variables: { id: 'a' },
  });
  expect(answerOf(['/v1/{name=things/**}', '/v1/things/{id}'], '/v1/things/a/b').index).toBe(0);

  const operations = ['/v1/{name=operations/**}', '/v1/{name=operations}'];

  expect(answerOf(operations, '/v1/operations')).toEqual({
    index: 1,
    variables: { name: 'operations' },
  });
  expect(answerOf(operations, '/v1/operations/abc')).toEqual({
    index: 0,
    variables: { name: 'operations/abc' },
  });
  expect(answerOf(['/api/{name=**}', '/api/Hello/sayHello'], '/api/Hello/sayHello').index).toBe(1);
});

test('splits the verb at the last colon its last segment holds unencoded', () => {
  expect(rawPathOf('/v1/books/a:b:archive')).toEqual({
    segments: ['v1', 'books', 'a:b'],
    verb: 'archive',
  });
  expect(rawPathOf('/v1/books/a%3Aarchive')).toEqual({ segments: ['v1', 'books', 'a%3Aarchive'] });

  const templates = ['/v1/{name=books/*}:archive', '/v1/{name=books/*}'];

  expect(answerOf(templates, '/v1/books/a:b:archive')).toEqual({
    index: 0,
    variables: { name: 'books/a:b' },
  });
  expect(answerOf(templates, '/v1/books/2%3Aarchive')).toEqual({
    index: 1,
    variables: { name: 'books/2:archive' },
  });
  expect(answerOf(templates, '/v1/books/2:frobnicate').index).toBeUndefined();
  expect(answerOf(['/v1/books/{name}'], '/v1/books/a:b').index).toBeUndefined();
});

test('answers a path two tying templates match by the first of them', () => {
  const templates = ['/v1/{a}/x', '/v1/{b=*}/x'].map(templateOf);

  expect(routeIndexOf(templates, pathOf('/v1/q/x'))).toBe(0);
  expect(routeIndexOf(templates.toReversed(), pathOf('/v1/q/x'))).toBe(0);
});
