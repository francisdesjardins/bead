import { create, fromBinary, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import { Int64ValueSchema, ValueSchema } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';
import { PresenceSchema } from '../../proto/__tests__/generated/validations_pb';
import {
  base64Of,
  JsonFormError,
  readJsonText,
  readProtoJson,
  typeRegistryOf,
  writeFieldJson,
  writeProtoJson,
} from '../json-form';
import {
  EdgesSchema,
  EverythingSchema,
  InnerSchema,
  ListBooksResponseSchema,
  type Aliased,
  type Edges,
  type Everything,
} from './generated/transcoding_pb';

// constants

const REGISTRY = typeRegistryOf([EdgesSchema, EverythingSchema]);

const INT64_VALUE_URL = 'type.googleapis.com/google.protobuf.Int64Value';

const ENCODER = new TextEncoder();

// helpers

const readEverything = (body: string): Everything => {
  return readProtoJson(EverythingSchema, {
    bytes: ENCODER.encode(body),
    registry: REGISTRY,
  }) as Everything;
};

const readEdges = (body: string): Edges => {
  return readProtoJson(EdgesSchema, { bytes: ENCODER.encode(body), registry: REGISTRY }) as Edges;
};

/** Why `body` is refused as an `Edges`, in the words of transcoding 5. */
const refusalOf = (body: string): string | undefined => {
  try {
    readEdges(body);
  } catch (error) {
    if (error instanceof JsonFormError) {
      return error.reason;
    }

    throw error;
  }

  return undefined;
};

/** Why `text` is refused as a JSON text, in the words of transcoding 5. */
const textRefusalOf = (text: string): string | undefined => {
  try {
    readJsonText(ENCODER.encode(text));
  } catch (error) {
    if (error instanceof JsonFormError) {
      return error.reason;
    }

    throw error;
  }

  return undefined;
};

/** `count` messages each the `child` of the one around it. */
const nestedEdges = (count: number): MessageInitShape<typeof EdgesSchema> => {
  let init: MessageInitShape<typeof EdgesSchema> = {};

  for (let index = 0; index < count; index += 1) {
    init = { child: init };
  }

  return init;
};

const writeEdges = (init: Parameters<typeof create<typeof EdgesSchema>>[1]): string => {
  // * through binary, as a result comes
  const message = fromBinary(EdgesSchema, toBinary(EdgesSchema, create(EdgesSchema, init)));

  return writeProtoJson(EdgesSchema, { message, registry: REGISTRY });
};

// tests

test('reads a proto body by Bead’s mapping, each scalar and well-known form as pinned', () => {
  const everything = readEverything(
    '{"an_int64":9007199254740993,"anInt32":"1e2","aUint64":"18446744073709551615","aFloat":"0.1","someBytes":"-_8","color":2,"renamed":"r","labels":{"a":1},"byId":{"-0":"z"},"flags":{"true":"t"},"maybe":0,"choiceText":null,"choiceInner":{"name":"n"},"at":"1970-01-01T08:00:01+08:00","took":"-0.5s","mask":"fooBar,a.bC","anyValue":[1,"x",null],"wrappedInt64":"7","extra":{"k":true}}'
  );

  expect(everything.anInt64).toBe(9_007_199_254_740_993n);
  expect(everything.anInt32).toBe(100);
  expect(everything.aUint64).toBe(18_446_744_073_709_551_615n);
  expect(everything.aFloat).toBe(Math.fround(0.1));
  expect(everything.someBytes).toEqual(Uint8Array.of(0xfb, 0xff));
  expect(everything.color).toBe(2);
  expect(everything.customNamed).toBe('r');
  expect(everything.labels).toEqual({ a: 1 });
  expect(everything.byId).toEqual({ '0': 'z' });
  expect(everything.flags).toEqual({ true: 't' });
  expect(everything.maybe).toBe(0);
  expect(everything.choice).toEqual({
    case: 'choiceInner',
    value: create(InnerSchema, { name: 'n' }),
  });
  expect(everything.at).toMatchObject({ nanos: 0, seconds: 1n });
  expect(everything.took).toMatchObject({ nanos: -500_000_000, seconds: 0n });
  expect(everything.mask?.paths).toEqual(['foo_bar', 'a.b_c']);
  expect(everything.anyValue?.kind.case).toBe('listValue');
  expect(everything.wrappedInt64).toBe(7n);
  expect(everything.extra).toEqual({ k: true });

  // what each form refuses, the stock libraries parting on many (decision 0037, D5 to D20)
  expect(refusalOf('{"anInt32":1,"an_int32":2}')).toBe('a field by its two names');
  expect(refusalOf('{"anInt64":"1e3"}')).toBe('an int64 string off -?(0|[1-9][0-9]*)');
  expect(refusalOf('{"anInt32":0.5}')).toBe('an int32 that is no integer');
  expect(refusalOf('{"aUint32":-1}')).toBe('a uint32 past its range');
  expect(refusalOf('{"someBytes":"+_8="}')).toBe('bytes of no one alphabet of base64');
  expect(refusalOf('{"someBytes":"AQ="}')).toBe('bytes padded wrongly');
  expect(refusalOf('{"byInt32":{"01":"a"}}')).toBe('an int32 key off -?(0|[1-9][0-9]*)');
  expect(refusalOf('{"at":"2026-02-30T00:00:00Z"}')).toBe('a Timestamp of no instant');
  expect(refusalOf('{"at":"2026-10-21T12:00:00z"}')).toBe('a Timestamp off RFC 3339');
  expect(refusalOf('{"took":"01s"}')).toBe('a Duration off its form');
  expect(refusalOf('{"mask":"FooBar"}')).toBe('a FieldMask path off lowerCamelCase');
  expect(refusalOf('{"mask":"a,,b"}')).toBe('a FieldMask of an empty path');
  expect(refusalOf('{"any":{"x":1}}')).toBe('an Any without its @type');
  expect(refusalOf('{"aliased":"aliased_first"}')).toBe('no value of Aliased of that name');
  expect(refusalOf('{"nullMember":null,"textMember":"a"}')).toBe('two members of one oneof');
  expect(refusalOf('{"ints":[1,null]}')).toBe('a null item');
  expect(refusalOf('{"anInt32":1,"an\\u0049nt32":2}')).toBe('a member named twice');
  expect(() => {
    return readJsonText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d));
  }).toThrow('a byte order mark');

  // an Any of a message its definitions hold, its @type in any place
  const edges = readEdges(
    '{"any":{"count":2,"@type":"type.googleapis.com/bead.transcoding.v1.Inner","name":"a"}}'
  );

  expect(edges.any?.typeUrl).toBe('type.googleapis.com/bead.transcoding.v1.Inner');
  expect(fromBinary(InnerSchema, edges.any?.value ?? new Uint8Array())).toMatchObject({
    count: 2,
    name: 'a',
  });
});

test('counts a body’s depth by its message, a Value nested past 100 refused before it is built', () => {
  const lists = (count: number, inside: string): string => {
    return `${'['.repeat(count)}${inside}${']'.repeat(count)}`;
  };
  const children = (count: number): string => {
    return `${'{"child":'.repeat(count)}{}${'}'.repeat(count)}`;
  };

  // * a Value at 1, each array a ListValue below it and each item a Value below that
  expect(refusalOf(`{"value":${lists(50, '')}}`)).toBeUndefined();
  expect(refusalOf(`{"value":${lists(50, '1')}}`)).toBe('nested past 100');
  expect(refusalOf(children(100))).toBeUndefined();
  expect(refusalOf(children(101))).toBe('nested past 100');
  // a map's entry is a message, its value one more
  expect(refusalOf(`${'{"child":'.repeat(99)}{"labels":{"a":1}}${'}'.repeat(99)}`)).toBeUndefined();
  expect(refusalOf(`${'{"child":'.repeat(100)}{"labels":{"a":1}}${'}'.repeat(100)}`)).toBe(
    'nested past 100'
  );
  // a repeated field's array counts nothing
  expect(refusalOf(`${'{"children":['.repeat(100)}{}${']}'.repeat(100)}`)).toBeUndefined();
  // a text past what any message nests is refused before its message is read, its nodes bounded
  expect(() => {
    return readJsonText(ENCODER.encode(lists(300, '')));
  }).toThrow('nested past 100');
});

test('writes a proto result in Bead’s proto JSON form, its fields by number, its maps sorted, @type first', () => {
  const message = fromBinary(
    EverythingSchema,
    toBinary(
      EverythingSchema,
      create(EverythingSchema, {
        aDouble: 1e21,
        aString: ' <>\u001f',
        anInt64: -5n,
        byId: { '10': 'x', '2': 'y', '-1': 'z' },
        customNamed: 'r',
        labels: { b: 1, a: 2, é: 3, Z: 4 },
        someBytes: Uint8Array.of(0xfb),
        wrappedInt64: 0n,
      })
    )
  );

  expect(writeProtoJson(EverythingSchema, { message, registry: REGISTRY })).toBe(
    '{"aDouble":1e+21,"anInt64":"-5","aString":" <>\\u001f","someBytes":"+w==","labels":{"Z":4,"a":2,"b":1,"é":3},"byId":{"-1":"z","10":"x","2":"y"},"wrappedInt64":"0","renamed":"r"}'
  );
  expect(
    writeEdges({
      any: {
        typeUrl: 'type.googleapis.com/bead.transcoding.v1.Inner',
        value: Uint8Array.of(0x10, 0x02),
      },
      extra: { b: 1, a: [true, null] },
    })
  ).toBe(
    '{"extra":{"a":[true,null],"b":1},"any":{"@type":"type.googleapis.com/bead.transcoding.v1.Inner","count":2}}'
  );
  expect(
    writeEdges({
      at: { nanos: 1000, seconds: -62_135_596_800n },
      mask: { paths: ['foo_bar', 'a.b_c'] },
      took: { nanos: -500_000_000, seconds: -1n },
    })
  ).toBe('{"at":"0001-01-01T00:00:00.000001Z","took":"-1.500s","mask":"fooBar,a.bC"}');

  // a response_body's field, at its default too
  const empty = create(ListBooksResponseSchema);

  expect(
    writeFieldJson(ListBooksResponseSchema, { message: empty, name: 'books', registry: REGISTRY })
  ).toBe('[]');

  // what the form holds none of (5.7)
  expect(() => {
    return writeEdges({ mask: { paths: ['foo_'] } });
  }).toThrow('a FieldMask path whose lowerCamelCase does not read back');
  expect(() => {
    return writeEdges({ value: { kind: { case: 'numberValue', value: Number.NaN } } });
  }).toThrow('a Value whose number is not finite');
  expect(() => {
    return writeEdges({
      any: { typeUrl: 'type.googleapis.com/nope.Nope', value: new Uint8Array() },
    });
  }).toThrow('an Any whose type its definitions do not hold');
});

test('writes an aliased enum by its first name, a float at its shortest, and a -0 left out', () => {
  expect(writeEdges({ aliased: 1 })).toBe('{"aliased":"ALIASED_FIRST"}');
  expect(writeEdges({ aliased: 7 as Aliased })).toBe('{"aliased":7}');
  expect(writeEdges({ aFloat: 0.1 })).toBe('{"aFloat":0.1}');
  expect(writeEdges({ aFloat: 3.4028234663852886e38 })).toBe('{"aFloat":3.4028235e+38}');
  expect(writeEdges({ aFloat: 1e-45 })).toBe('{"aFloat":1e-45}');
  expect(writeEdges({ wrappedFloat: 0.1 })).toBe('{"wrappedFloat":0.1}');
  expect(writeEdges({ aFloat: Number.POSITIVE_INFINITY })).toBe('{"aFloat":"Infinity"}');
  expect(writeEdges({ aDouble: -0 })).toBe('{}');
  expect(writeEdges({ aFloat: -0 })).toBe('{}');
  expect(writeEdges({ maybeDouble: -0 })).toBe('{"maybeDouble":0}');
  expect(base64Of(Uint8Array.of(0, 0xff, 0xfe))).toBe('AP/+');
});

test('refuses a text that is no JSON: a string left open or wrongly escaped, a comma or a colon missing', () => {
  expect(textRefusalOf('{"a')).toBe('not JSON');
  expect(textRefusalOf('{"a":"\\q"}')).toBe('not JSON');
  expect(textRefusalOf('[1 2]')).toBe('not JSON');
  expect(textRefusalOf('{"a" 1}')).toBe('not JSON');
  expect(textRefusalOf('{"a":1 "b":2}')).toBe('not JSON');
  expect(textRefusalOf('{"a":[1,2],"b":{}}')).toBeUndefined();
});

test('refuses a value its field’s type holds none of, each by its reason', () => {
  expect(refusalOf('{"anInt32":"0.5"}')).toBe('an int32 that is no integer');
  expect(refusalOf('{"anInt32":1e30}')).toBe('an int32 past its range');
  expect(refusalOf('{"aDouble":"1e400"}')).toBe('a double past its range');
  expect(refusalOf('{"someBytes":1}')).toBe('no bytes');
  expect(refusalOf('{"aliased":true}')).toBe('no Aliased');
  expect(refusalOf('{"aliased":2147483648}')).toBe('an enum number past its range');
  expect(refusalOf('{"at":1}')).toBe('a Timestamp that is no string');
  expect(refusalOf('{"extra":1}')).toBe('a Struct that is no object');
  expect(refusalOf('{"any":1}')).toBe('an Any that is no object');
  expect(refusalOf('{"labels":1}')).toBe('a map that is no object');
  expect(
    refusalOf('{"any":{"@type":"type.googleapis.com/google.protobuf.ListValue","value":1}}')
  ).toBe('a ListValue that is no array');
});

test('reads and writes an Any of a wrapper by its value, and a wrapper alone as its scalar', () => {
  const edges = readEdges(`{"any":{"@type":"${INT64_VALUE_URL}","value":"7"}}`);

  expect(edges.any?.typeUrl).toBe(INT64_VALUE_URL);
  expect(fromBinary(Int64ValueSchema, edges.any?.value ?? new Uint8Array()).value).toBe(7n);
  expect(
    writeEdges({
      any: {
        typeUrl: INT64_VALUE_URL,
        value: toBinary(Int64ValueSchema, create(Int64ValueSchema, { value: 7n })),
      },
    })
  ).toBe(`{"any":{"@type":"${INT64_VALUE_URL}","value":"7"}}`);
  expect(
    writeProtoJson(Int64ValueSchema, {
      message: create(Int64ValueSchema, { value: -3n }),
      registry: REGISTRY,
    })
  ).toBe('"-3"');
});

test('writes each kind of Value, and a Struct within a Struct, in its own form', () => {
  expect(writeEdges({ value: { kind: { case: 'nullValue', value: 0 } } })).toBe('{"value":null}');
  expect(writeEdges({ value: { kind: { case: 'boolValue', value: false } } })).toBe(
    '{"value":false}'
  );
  expect(
    writeEdges({
      value: {
        kind: {
          case: 'structValue',
          value: { fields: { b: { kind: { case: 'stringValue', value: 'x' } } } },
        },
      },
    })
  ).toBe('{"value":{"b":"x"}}');
  expect(writeEdges({ extra: { a: { b: 1, c: [] } } })).toBe('{"extra":{"a":{"b":1,"c":[]}}}');
});

test('writes a message nested 100 deep, and refuses one nested past 100', () => {
  expect(
    writeProtoJson(EdgesSchema, {
      message: create(EdgesSchema, nestedEdges(100)),
      registry: REGISTRY,
    })
  ).toMatch(/^\{"child":/u);
  expect(() => {
    return writeProtoJson(EdgesSchema, {
      message: create(EdgesSchema, nestedEdges(101)),
      registry: REGISTRY,
    });
  }).toThrow('a message nested past 100');
});

test('writes a response body’s field at its default where its oneof holds another member or none', () => {
  const chosen = create(EverythingSchema, { choice: { case: 'choiceText', value: 'x' } });
  const empty = create(EverythingSchema);

  expect(
    writeFieldJson(EverythingSchema, { message: chosen, name: 'choice_text', registry: REGISTRY })
  ).toBe('"x"');
  expect(
    writeFieldJson(EverythingSchema, { message: chosen, name: 'choiceInner', registry: REGISTRY })
  ).toBe('{}');
  expect(
    writeFieldJson(EverythingSchema, { message: empty, name: 'choiceText', registry: REGISTRY })
  ).toBe('""');
  expect(
    writeFieldJson(EverythingSchema, { message: empty, name: 'inner', registry: REGISTRY })
  ).toBe('{}');
  expect(
    writeFieldJson(EdgesSchema, {
      message: create(EdgesSchema),
      name: 'nullMember',
      registry: REGISTRY,
    })
  ).toBe('null');
  expect(
    writeFieldJson(ValueSchema, {
      message: create(ValueSchema),
      name: 'numberValue',
      registry: REGISTRY,
    })
  ).toBe('0');
  expect(
    writeFieldJson(ValueSchema, {
      message: create(ValueSchema),
      name: 'bool_value',
      registry: REGISTRY,
    })
  ).toBe('false');
  expect(() => {
    return writeFieldJson(EverythingSchema, { message: empty, name: 'nope', registry: REGISTRY });
  }).toThrow('a response body that names no field of its result');
});

test('writes a field of its own presence where it is set, at its default too, and leaves it out unset', () => {
  const registry = typeRegistryOf([PresenceSchema]);

  // * `explicit` and `needed` of edition 2023's explicit presence, `implicit` of its own
  expect(writeProtoJson(PresenceSchema, { message: create(PresenceSchema), registry })).toBe('{}');
  expect(
    writeProtoJson(PresenceSchema, {
      message: create(PresenceSchema, { explicit: '', implicit: '' }),
      registry,
    })
  ).toBe('{"explicit":""}');
});

// TypeScript alone: a JavaScript number is a double, which a float field may hold unrounded
test('writes a float field that holds what no 32-bit float holds as the double it holds', () => {
  expect(
    writeProtoJson(EdgesSchema, {
      message: create(EdgesSchema, { aFloat: 0.1 }),
      registry: REGISTRY,
    })
  ).toBe('{"aFloat":0.1}');
});
