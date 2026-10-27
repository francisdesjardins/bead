import { create } from '@bufbuild/protobuf';
import { AnySchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../transport/shared/errors';
import { bindRequest, type IBindingOptions } from '../binding';
import { JsonFormError, typeRegistryOf } from '../json-form';
import {
  PatchRequestSchema,
  type PatchRequest,
} from './binding-fixtures/generated/patch_binding_pb';
import {
  EverythingSchema,
  GetBookRequestSchema,
  UpdateBookRequestSchema,
  type Everything,
  type GetBookRequest,
  type UpdateBookRequest,
} from './generated/transcoding_pb';

// constants

const REGISTRY = typeRegistryOf([EverythingSchema, GetBookRequestSchema, UpdateBookRequestSchema]);

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

const everything = (options: Omit<IBindingOptions, 'registry'>): Everything => {
  return bindRequest(EverythingSchema, { ...options, registry: REGISTRY }) as Everything;
};

/** Why `bind` is refused, in the words of transcoding 4 and 5. */
const reasonOf = (bind: () => unknown): string | undefined => {
  try {
    bind();
  } catch (error) {
    if (error instanceof JsonFormError) {
      return error.reason;
    }

    throw error;
  }

  return undefined;
};

/** Why binding `query` to `getBook`'s default `GET` is refused. */
const refusalOf = (query: string): string | undefined => {
  return reasonOf(() => {
    return getBook({ query, variables: {} });
  });
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

test('binds a wrapper and a well-known type of a string form from a parameter, never a Struct, a Value or a ListValue', () => {
  expect(
    everything({
      query: 'wrappedInt64=7&wrappedBool=true&took=1.5s&wrappedString=x&at=1970-01-01T00:00:01Z',
      variables: {},
    })
  ).toEqual(
    create(EverythingSchema, {
      at: { seconds: 1n },
      took: { nanos: 500_000_000, seconds: 1n },
      wrappedBool: true,
      wrappedInt64: 7n,
      wrappedString: 'x',
    })
  );
  expect(
    reasonOf(() => {
      return everything({ query: 'extra=x', variables: {} });
    })
  ).toBe('a parameter of a message');
  expect(
    reasonOf(() => {
      return everything({ query: 'anyValue=x', variables: {} });
    })
  ).toBe('a parameter of a message');
  expect(
    reasonOf(() => {
      return everything({ query: 'list=x', variables: {} });
    })
  ).toBe('a parameter of a message');
});

test('reads a parameter without its = as an empty value, and an enum’s by its name or its number', () => {
  expect(getBook({ query: 'name&revision=2&color=COLOR_GREEN', variables: {} })).toEqual(
    create(GetBookRequestSchema, { color: 2, revision: 2n })
  );
  expect(getBook({ query: 'color=1', variables: {} }).color).toBe(1);
  expect(refusalOf('flag')).toBe('no bool');

  // * an empty sequence skipped, a name with no `=` an empty value, false a bool, a character
  // beyond the BMP percent-encoded
  expect(
    getBook({
      query: '&flag=false&&tags&tags=%F0%9F%98%80&sub.name=a=b&',
      variables: { name: '2' },
    })
  ).toEqual(create(GetBookRequestSchema, { name: '2', sub: { name: 'a=b' }, tags: ['', '😀'] }));
  expect(getBook({ query: 'flag=true&revision=-1', variables: { name: '2' } })).toEqual(
    create(GetBookRequestSchema, { flag: true, name: '2', revision: -1n })
  );
});

test('refuses a body that is no object as the request whole, or under a field a variable sets inside', () => {
  expect(
    reasonOf(() => {
      return getBook({
        body: ENCODER.encode('1'),
        routeBody: '*',
        variables: { name: 'shelves/1/books/2' },
      });
    })
  ).toBe('a GetBookRequest that is no object');
  expect(
    reasonOf(() => {
      return getBook({
        body: ENCODER.encode('1'),
        routeBody: 'sub',
        variables: { 'sub.name': 'x' },
      });
    })
  ).toBe('a field that two of the request set');
});

test('fills no update_mask path of a PATCH’s body that is no object, and refuses a member of it that names no field', () => {
  const read = bindRequest(UpdateBookRequestSchema, {
    body: ENCODER.encode('null'),
    isPatch: true,
    registry: REGISTRY,
    routeBody: 'book',
    variables: {},
  }) as UpdateBookRequest;

  expect(read.book).toBeUndefined();
  expect(read.updateMask?.paths).toEqual([]);
  expect(
    reasonOf(() => {
      return updateBook('{"title":"t","nope":1}');
    })
  ).toBe('a key no field names');
});

test('fills a PATCH mask from snake-case fields through nested and empty message bodies', () => {
  for (const body of [
    '{"displayName":"Ada","nestedProfile":{"displayName":"Grace"},"emptyProfile":{}}',
    '{"display_name":"Ada","nested_profile":{"display_name":"Grace"},"empty_profile":{}}',
  ]) {
    const read = bindRequest(PatchRequestSchema, {
      body: ENCODER.encode(body),
      isPatch: true,
      registry: typeRegistryOf([PatchRequestSchema]),
      routeBody: 'profile',
      variables: {},
    }) as PatchRequest;

    expect(read).toEqual(
      create(PatchRequestSchema, {
        profile: {
          displayName: 'Ada',
          nestedProfile: { displayName: 'Grace' },
          emptyProfile: {},
        },
        updateMask: { paths: ['display_name', 'nested_profile.display_name', 'empty_profile'] },
      })
    );
  }
});

test('throws a programmer’s error for a variable that names no field', () => {
  expect(() => {
    return getBook({ variables: { 'sub.nope': 'x' } });
  }).toThrow(ProgrammerError);
});

test('propagates a supplied type registry’s error without placing it in the request', () => {
  for (const failure of [
    new Error('the type registry failed'),
    new JsonFormError('the registry refuses'),
  ]) {
    const lookedUp: string[] = [];
    let caught: unknown;

    try {
      bindRequest(AnySchema, {
        body: ENCODER.encode(
          '{"@type":"type.example/bead.transcoding.GetBookRequest","name":"books/1"}'
        ),
        registry: {
          messageOf: (name) => {
            lookedUp.push(name);
            throw failure;
          },
        },
        routeBody: '*',
        variables: {},
      });
    } catch (error) {
      caught = error;
    }

    expect(lookedUp).toEqual(['bead.transcoding.GetBookRequest']);
    expect(caught).toBe(failure);
    if (caught instanceof JsonFormError) {
      expect(caught.at).toBeUndefined();
      expect(caught.place).toBeUndefined();
    }
  }
});
