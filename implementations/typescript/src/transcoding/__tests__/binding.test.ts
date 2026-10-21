import { expect, test } from '@playwright/test';
import { bindRequest, type IBindingOptions } from '../binding';
import { JsonFormError, typeRegistryOf } from '../json-form';
import {
  GetBookRequestSchema,
  UpdateBookRequestSchema,
  type GetBookRequest,
  type UpdateBookRequest,
} from './generated/transcoding_pb';

// constants

const REGISTRY = typeRegistryOf([GetBookRequestSchema, UpdateBookRequestSchema]);

const ENCODER = new TextEncoder();

// helpers

const getBook = (options: Omit<IBindingOptions, 'registry'>): GetBookRequest => {
  return bindRequest(GetBookRequestSchema, { ...options, registry: REGISTRY }) as GetBookRequest;
};

const updateBook = (body: string, query?: string): UpdateBookRequest => {
  return bindRequest(UpdateBookRequestSchema, {
    body: ENCODER.encode(body),
    isPatch: true,
    ...(query === undefined ? {} : { query }),
    registry: REGISTRY,
    routeBody: 'book',
    variables: { 'book.name': 'shelves/1/books/2' },
  }) as UpdateBookRequest;
};

/** Why binding `query` to `getBook`'s default `GET` is refused. */
const refusalOf = (query: string): string | undefined => {
  try {
    getBook({ query, variables: {} });
  } catch (error) {
    if (error instanceof JsonFormError) {
      return error.reason;
    }

    throw error;
  }

  return undefined;
};

// tests

test('binds a path variable, the query and the body into one request, as http.proto’s rules state', () => {
  const read = getBook({
    query:
      'revision=3&tags=a+b&tags=c%2Bd&sub.name=x&sub.count=1e1&at=1970-01-01T00:00:01Z&color=2&flag=true',
    variables: { name: 'shelves/1/books/2' },
  });

  expect(read).toMatchObject({
    color: 2,
    flag: true,
    name: 'shelves/1/books/2',
    revision: 3n,
    sub: { count: 10, name: 'x' },
    tags: ['a b', 'c+d'],
  });
  expect(read.at?.seconds).toBe(1n);

  // a body of the request whole, beside a variable
  const whole = getBook({
    body: ENCODER.encode('{"revision":"4","sub":{"name":"y"}}'),
    routeBody: '*',
    variables: { name: 'shelves/1/books/2' },
  });

  expect(whole).toMatchObject({ name: 'shelves/1/books/2', revision: 4n, sub: { name: 'y' } });

  // one field, one value; no query under a body of the request whole
  expect(() => {
    return getBook({
      body: ENCODER.encode('{"name":"x"}'),
      routeBody: '*',
      variables: { name: 'shelves/1/books/2' },
    });
  }).toThrow('a field that two of the request set');
  expect(() => {
    return getBook({
      body: ENCODER.encode('{}'),
      query: 'revision=1',
      routeBody: '*',
      variables: {},
    });
  }).toThrow('a query beside a body of the whole request');
  expect(() => {
    return getBook({ body: new Uint8Array(), routeBody: '*', variables: {} });
  }).toThrow('not JSON');
});

test('refuses a parameter no field names, a field named twice, and a repeated message or a map in the query', () => {
  expect(refusalOf('nope=1')).toBe('a parameter no field path names');
  expect(refusalOf('inners.name=x')).toBe('a parameter no field path names');
  expect(refusalOf('revision=1&revision=2')).toBe('a field the query names twice');
  expect(refusalOf('sub.count=1&sub.count=2')).toBe('a field the query names twice');
  expect(refusalOf('inners=x')).toBe('a parameter of a map or a repeated message');
  expect(refusalOf('labels=x')).toBe('a parameter of a map or a repeated message');
  expect(refusalOf('sub=x')).toBe('a parameter of a message');
  expect(refusalOf('name=%FF')).toBe('a query whose bytes are not UTF-8');
  expect(refusalOf('revision=1e3')).toBe('an int64 string off -?(0|[1-9][0-9]*)');
  expect(refusalOf('flag=1')).toBe('no bool');
  // a repeated scalar repeats, by either of its names; an empty sequence is skipped
  expect(refusalOf('tags=a&&tags=b')).toBeUndefined();
  expect(getBook({ query: 'name=100%', variables: {} }).name).toBe('100%');
  expect(() => {
    return getBook({ query: 'name=x', variables: { name: 'shelves/1/books/2' } });
  }).toThrow('a parameter of a field the route binds otherwise');
});

test('fills a PATCH’s update_mask with the keys its body holds', () => {
  expect(updateBook('{"title":"New","pages":"3"}').updateMask?.paths).toEqual(['title', 'pages']);
  expect(updateBook('{"author":{"name":"a","count":1},"title":"t"}').updateMask?.paths).toEqual([
    'author.name',
    'author.count',
    'title',
  ]);
  expect(updateBook('{"author":{}}').updateMask?.paths).toEqual(['author']);
  expect(updateBook('{"title":null}').updateMask?.paths).toEqual(['title']);
  expect(updateBook('{}').updateMask?.paths).toEqual([]);
  // the query's own, which the body's keys leave as it is
  expect(updateBook('{"title":"x","pages":"1"}', 'updateMask=title').updateMask?.paths).toEqual([
    'title',
  ]);
  expect(() => {
    return updateBook('{"name":"other"}');
  }).toThrow('a field that two of the request set');
  expect(updateBook('{"title":"x"}').book?.name).toBe('shelves/1/books/2');
});
