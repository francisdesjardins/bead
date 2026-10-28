import {
  create,
  type DescMessage,
  fromBinary,
  type Message,
  type MessageInitShape,
  toBinary,
  toJson,
} from '@bufbuild/protobuf';
import {
  AnySchema,
  EmptySchema,
  FieldDescriptorProtoSchema,
  FieldOptionsSchema,
  Int32ValueSchema,
  Int64ValueSchema,
  ListValueSchema,
  StringValueSchema,
  UninterpretedOption_NamePartSchema,
  ValueSchema,
  type FieldOptions,
} from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';
import {
  MapsSchema,
  PresenceSchema,
  type Maps,
} from '../../proto/__tests__/generated/validations_pb';
import { ProgrammerError } from '../../transport/shared/errors';
import { PatchProfileSchema } from './binding-fixtures/generated/patch_binding_pb';
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

const INT32_VALUE_URL = 'type.googleapis.com/google.protobuf.Int32Value';

const INT64_VALUE_URL = 'type.googleapis.com/google.protobuf.Int64Value';

const ENCODER = new TextEncoder();

test('refuses empty and trailing JSON texts through the public message reader', () => {
  for (const text of ['', ' \t\r\n', '{} {}', '{} true', '[] 0', 'null false', '{}x']) {
    expect(() => {
      return readProtoJson(EmptySchema, { bytes: ENCODER.encode(text), registry: REGISTRY });
    }).toThrow('not JSON');
  }
});

test('bounds JSON arrays and objects before reading a message', () => {
  for (const text of [
    '['.repeat(203) + ']'.repeat(203),
    '{"a":'.repeat(203) + '0' + '}'.repeat(203),
  ]) {
    expect(() => {
      return readProtoJson(EmptySchema, { bytes: ENCODER.encode(text), registry: REGISTRY });
    }).toThrow('nested past 100');
  }
});

test('packs an Any with unset proto2 required fields and keeps explicit defaults on repeated reads', () => {
  const registry = typeRegistryOf([UninterpretedOption_NamePartSchema]);
  const typeUrl = 'type.googleapis.com/google.protobuf.UninterpretedOption.NamePart';
  const cases = [
    { members: '', bytes: [] },
    { members: ',"namePart":"Ada"', bytes: [10, 3, 65, 100, 97] },
    { members: ',"namePart":"","isExtension":false', bytes: [10, 0, 16, 0] },
  ];

  for (const { members, bytes } of cases) {
    const text = `{"@type":"${typeUrl}"${members}}`;
    for (let pass = 0; pass < 2; pass += 1) {
      const any = readProtoJson(AnySchema, { bytes: ENCODER.encode(text), registry });

      expect(any).toEqual(create(AnySchema, { typeUrl, value: Uint8Array.from(bytes) }));
      expect(writeProtoJson(AnySchema, { message: any, registry })).toBe(text);
    }
  }
});

test('reads and writes signed infinities and NaN in double and float fields', () => {
  for (const [word, value] of [
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ] as const) {
    const text = `{"aDouble":"${word}","aFloat":"${word}"}`;
    const message = readEdges(text);
    expect(message.aDouble).toBe(value);
    expect(message.aFloat).toBe(value);
    expect(writeProtoJson(EdgesSchema, { message, registry: REGISTRY })).toBe(
      `{"aFloat":"${word}","aDouble":"${word}"}`
    );
    expect(fromBinary(EdgesSchema, toBinary(EdgesSchema, message))).toEqual(message);
  }
});

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

/** An `Edges`'s Value, as the JSON it holds. */
const valueJsonOf = (edges: Edges): unknown => {
  return toJson(ValueSchema, edges.value ?? create(ValueSchema));
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

test('reads enum lists by name or number and refuses an invalid member at its index', () => {
  const expected = create(FieldOptionsSchema, { targets: [1, 4] });

  for (const body of [
    '{"targets":[1,4]}',
    '{"targets":["TARGET_TYPE_FILE","TARGET_TYPE_FIELD"]}',
  ]) {
    const message = readProtoJson(FieldOptionsSchema, {
      bytes: ENCODER.encode(body),
      registry: REGISTRY,
    }) as FieldOptions;

    expect(message).toEqual(expected);
    expect(fromBinary(FieldOptionsSchema, toBinary(FieldOptionsSchema, message))).toEqual(expected);
    expect(writeProtoJson(FieldOptionsSchema, { message, registry: REGISTRY })).toBe(
      '{"targets":["TARGET_TYPE_FILE","TARGET_TYPE_FIELD"]}'
    );
  }

  for (const [member, reason] of [
    ['999', 'no value of OptionTargetType of that number'],
    ['"NOPE"', 'no value of OptionTargetType of that name'],
    ['true', 'no OptionTargetType'],
  ]) {
    expect(() => {
      readProtoJson(FieldOptionsSchema, {
        bytes: ENCODER.encode(`{"targets":[1,${member}]}`),
        registry: REGISTRY,
      });
    }).toThrow(expect.objectContaining({ pointer: '#/targets/1', reason }));
  }
});

test('refuses unknown numbers of a closed enum and keeps open enum numbers', () => {
  const read = (body: string) => {
    return readProtoJson(FieldDescriptorProtoSchema, {
      bytes: ENCODER.encode(body),
      registry: REGISTRY,
    });
  };

  for (const body of ['{"type":1}', '{"type":"TYPE_DOUBLE"}']) {
    const message = read(body);

    expect(message).toEqual(create(FieldDescriptorProtoSchema, { type: 1 }));
    expect(writeProtoJson(FieldDescriptorProtoSchema, { message, registry: REGISTRY })).toBe(
      '{"type":"TYPE_DOUBLE"}'
    );
  }

  for (const body of ['{"type":0}', '{"type":999}']) {
    let refused: unknown;

    try {
      read(body);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(JsonFormError);
    expect(refused).toMatchObject({
      pointer: '#/type',
      reason: 'no value of Type of that number',
    });
  }

  expect(readEdges('{"aliased":7}').aliased).toBe(7);
  expect(writeEdges({ aliased: 7 as Aliased })).toBe('{"aliased":7}');
});

test('refuses an Empty value that is not an object', () => {
  for (const body of ['1', '[]']) {
    let refused: unknown;

    try {
      readProtoJson(EmptySchema, { bytes: ENCODER.encode(body), registry: REGISTRY });
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(JsonFormError);
    expect(refused).toMatchObject({ pointer: '#', reason: 'an Empty that is no object' });
  }
});

test('reads unsigned 64-bit map keys exactly and refuses keys outside their bounds', () => {
  for (const [field, kind] of [
    ['byUint64', 'uint64'],
    ['byFixed64', 'fixed64'],
  ] as const) {
    const read = (body: string) => {
      return readProtoJson(MapsSchema, { bytes: ENCODER.encode(body), registry: REGISTRY }) as Maps;
    };
    const message = read(
      `{"${field}":{"9007199254740993":"large","18446744073709551615":"max","0":"zero"}}`
    );
    const expected = create(MapsSchema, {
      [field]: { '0': 'zero', '9007199254740993': 'large', '18446744073709551615': 'max' },
    });

    expect(message).toEqual(expected);
    expect(fromBinary(MapsSchema, toBinary(MapsSchema, message))).toEqual(expected);
    expect(writeProtoJson(MapsSchema, { message, registry: REGISTRY })).toBe(
      `{"${field}":{"0":"zero","18446744073709551615":"max","9007199254740993":"large"}}`
    );

    for (const [key, reason] of [
      ['-1', `a ${kind} key past its range`],
      ['18446744073709551616', `a ${kind} key past its range`],
      ['01', `a ${kind} key off -?(0|[1-9][0-9]*)`],
      ['1e3', `a ${kind} key off -?(0|[1-9][0-9]*)`],
    ]) {
      let refused: unknown;

      try {
        read(`{"${field}":{"${key}":"x"}}`);
      } catch (error) {
        refused = error;
      }

      expect(refused).toBeInstanceOf(JsonFormError);
      expect(refused).toMatchObject({ pointer: `#/${field}/${key}`, reason });
    }
  }
});

test('reads the limits of unsigned 64-bit numbers without rounding', () => {
  for (const digits of ['0', '9007199254740993', '18446744073709551615']) {
    for (const value of [digits, `"${digits}"`]) {
      expect(readEverything(`{"aUint64":${value}}`).aUint64).toBe(BigInt(digits));
    }
  }

  for (const value of ['-1', '18446744073709551616']) {
    expect(() => {
      return readEverything(`{"aUint64":${value}}`);
    }).toThrow('a uint64 past its range');
  }
});

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
  expect(refusalOf('{"anInt32":1,"anInt32":2}')).toBe('a member named twice');
  expect(refusalOf('{"wrappedInt64":"1e3"}')).toBe('an int64 string off -?(0|[1-9][0-9]*)');
  expect(refusalOf('{"took":"1.0000000001s"}')).toBe('a Duration off its form');
  expect(refusalOf('{"nope":1}')).toBe('a key no field names');
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
  expect(writeEdges({ aFloat: 3.4028234663852886e38, wrappedFloat: 0.1 })).toBe(
    '{"wrappedFloat":0.1,"aFloat":3.4028235e+38}'
  );
  expect(writeEdges({ aFloat: 1e-45 })).toBe('{"aFloat":1e-45}');
  expect(writeEdges({ aFloat: Number.POSITIVE_INFINITY })).toBe('{"aFloat":"Infinity"}');
  expect(writeEdges({ aDouble: -0, aFloat: -0 })).toBe('{}');
  expect(writeEdges({ someBytes: Uint8Array.of(0, 0xff, 0xfe) })).toBe('{"someBytes":"AP/+"}');
  expect(base64Of(Uint8Array.of(0, 0xff, 0xfe))).toBe('AP/+');

  // a field of its own presence at -0 is written, 0
  expect(writeEdges({ maybeDouble: -0 })).toBe('{"maybeDouble":0}');
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
  const parted: string[] = [];

  for (const [schema, body, words] of [
    [EdgesSchema, '{"labels":[]}', 'a map that is no object'],
    [EdgesSchema, '{"labels":1}', 'a map that is no object'],
    [EdgesSchema, '{"anInt32":"0.5"}', 'an int32 that is no integer'],
    [EdgesSchema, '{"anInt32":1e30}', 'an int32 past its range'],
    [EdgesSchema, '{"extra":1}', 'a Struct that is no object'],
    [
      EdgesSchema,
      '{"any":{"@type":"type.googleapis.com/google.protobuf.ListValue","value":1}}',
      'a ListValue that is no array',
    ],
    [EdgesSchema, '{"ints":1}', 'a repeated field that is no array'],
    [EdgesSchema, '{"ints":[null]}', 'a null item'],
    [EdgesSchema, '{"labels":{"a":null}}', 'a null value in a map'],
    [EdgesSchema, '{"aliased":1.5}', 'an enum number that is no integer'],
    [EdgesSchema, '{"aliased":2147483648}', 'an enum number past its range'],
    [EdgesSchema, '{"aliased":true}', 'no Aliased'],
    [EdgesSchema, '{"aliased":"NOPE"}', 'no value of Aliased of that name'],
    [EdgesSchema, '{"aDouble":"abc"}', 'no double'],
    [EdgesSchema, '{"aDouble":true}', 'no double'],
    [EdgesSchema, '{"aDouble":"1e400"}', 'a double past its range'],
    [EdgesSchema, '{"aFloat":"1e400"}', 'a float past its range'],
    [EdgesSchema, '{"someBytes":1}', 'no bytes'],
    [EdgesSchema, '{"someBytes":"AAAAA"}', 'bytes padded wrongly'],
    [EdgesSchema, '{"byUint32":{"4294967296":"a"}}', 'a uint32 key past its range'],
    [EdgesSchema, '{"byInt64":{"1":"a","01":"b"}}', 'an int64 key off -?(0|[1-9][0-9]*)'],
    [EverythingSchema, '{"flags":{"maybe":"a"}}', 'a bool key that is neither true nor false'],
    [EdgesSchema, '{"anInt32":1e41}', 'an int32 past its range'],
    [EdgesSchema, '{"anInt32":1e-41}', 'an int32 that is no integer'],
    [EdgesSchema, '{"anInt32":true}', 'no int32'],
    [EverythingSchema, '{"aUint64":"18446744073709551616"}', 'a uint64 past its range'],
    [EverythingSchema, '{"aFixed64":-1}', 'a fixed64 past its range'],
    [EverythingSchema, '{"aSint64":"1.5"}', 'an sint64 string off -?(0|[1-9][0-9]*)'],
    [EverythingSchema, '{"aString":1}', 'no string'],
    [EdgesSchema, '{"extra":[]}', 'a Struct that is no object'],
    [EverythingSchema, '{"list":{}}', 'a ListValue that is no array'],
    [EdgesSchema, '{"any":1}', 'an Any that is no object'],
    [EdgesSchema, '{"any":{"@type":1}}', 'an Any whose @type is no URL'],
    [
      EdgesSchema,
      '{"any":{"@type":"type.googleapis.com/bead.transcoding.v1.Nope"}}',
      'an Any of a type its definitions do not hold',
    ],
    [
      EdgesSchema,
      '{"any":{"@type":"type.googleapis.com/google.protobuf.Duration","seconds":1}}',
      'an Any of a well-known type whose members are not its value alone',
    ],
    [EdgesSchema, '{"child":1}', 'an Edges that is no object'],
    [EdgesSchema, '{"at":1}', 'a Timestamp that is no string'],
    [EdgesSchema, '{"at":"yesterday"}', 'a Timestamp off RFC 3339'],
    [EdgesSchema, '{"at":"2026-01-01T24:00:00Z"}', 'a Timestamp of no instant'],
    [EdgesSchema, '{"at":"2026-04-31T00:00:00Z"}', 'a Timestamp of no instant'],
    [EdgesSchema, '{"at":"1900-02-29T00:00:00Z"}', 'a Timestamp of no instant'],
    [EdgesSchema, '{"at":"2026-01-01T00:00:00+24:00"}', 'a Timestamp of no offset'],
    [EdgesSchema, '{"at":"0000-01-01T00:00:00Z"}', 'a Timestamp past its range'],
    [EdgesSchema, '{"took":1}', 'a Duration off its form'],
    [EdgesSchema, '{"took":"315576000001s"}', 'a Duration past its range'],
    [EdgesSchema, '{"mask":1}', 'a FieldMask that is no string'],
  ] as const) {
    try {
      readProtoJson(schema, { bytes: ENCODER.encode(body), registry: REGISTRY });
      parted.push(`${body}: taken, where ${words}`);
    } catch (error) {
      if (!(error instanceof JsonFormError)) {
        throw error;
      }

      if (error.reason !== words) {
        parted.push(`${body}: ${error.reason}, where ${words}`);
      }
    }
  }

  expect(parted).toEqual([]);
});

test('reads each well-known form at its edges', () => {
  // * a leap day of a year that 400 divides, the earliest instant, an Empty, a Value of each kind
  expect(readEdges('{"at":"2000-02-29T00:00:00Z"}').at).toMatchObject({
    nanos: 0,
    seconds: 951_782_400n,
  });
  expect(readEdges('{"at":"0001-01-01T00:00:00Z"}').at).toMatchObject({
    nanos: 0,
    seconds: -62_135_596_800n,
  });
  expect(readEdges('{"nothing":{}}').nothing).toEqual(create(EmptySchema));
  expect(valueJsonOf(readEdges('{"value":false}'))).toBe(false);
  expect(valueJsonOf(readEdges('{"value":{"a":[null,"b"]}}'))).toEqual({ a: [null, 'b'] });

  const everything = readEverything('{"list":[1],"wrappedBool":true,"wrappedString":""}');

  expect(toJson(ListValueSchema, everything.list ?? create(ListValueSchema))).toEqual([1]);
  expect(everything.wrappedBool).toBe(true);
  expect(everything.wrappedString).toBe('');

  // a map of each key's form, bytes of the URL-safe alphabet, the empty Any
  const keyed = readEverything(
    '{"flags":{"true":"t","false":"f"},"byId":{"-1":"a"},"someBytes":"-_8"}'
  );

  expect(keyed.flags).toEqual({ false: 'f', true: 't' });
  expect(keyed.byId).toEqual({ '-1': 'a' });
  expect(keyed.someBytes).toEqual(Uint8Array.of(0xfb, 0xff));
  expect(readEdges('{"byUint32":{"4294967295":"a"}}').byUint32).toEqual({ '4294967295': 'a' });
  expect(readEdges('{"any":{}}').any).toEqual(create(AnySchema));
});

test('writes each well-known form at its edges, and refuses what its form holds none of', () => {
  // * a second before the epoch, an Any of an Empty, the empty Any, a map of bool keys
  expect(writeEdges({ at: { nanos: 500_000_000, seconds: -1n } })).toBe(
    '{"at":"1969-12-31T23:59:59.500Z"}'
  );
  expect(
    writeEdges({
      any: { typeUrl: 'type.googleapis.com/google.protobuf.Empty', value: new Uint8Array() },
    })
  ).toBe('{"any":{"@type":"type.googleapis.com/google.protobuf.Empty"}}');
  expect(writeEdges({ any: {} })).toBe('{"any":{}}');
  expect(writeEdges({ took: { nanos: -1, seconds: -1n } })).toBe('{"took":"-1.000000001s"}');
  expect(writeEdges({ took: { nanos: 1000 } })).toBe('{"took":"0.000001s"}');
  expect(
    writeProtoJson(EverythingSchema, {
      message: create(EverythingSchema, { flags: { true: 't', false: 'f' } }),
      registry: REGISTRY,
    })
  ).toBe('{"flags":{"false":"f","true":"t"}}');

  const parted: string[] = [];

  for (const [init, words] of [
    [{ at: { nanos: -1 } }, 'a Timestamp outside its range'],
    [{ at: { seconds: 253_402_300_800n } }, 'a Timestamp outside its range'],
    [{ took: { nanos: -1, seconds: 1n } }, 'a Duration outside its range'],
    [{ took: { seconds: 315_576_000_001n } }, 'a Duration outside its range'],
    [{ any: { typeUrl: 'nope' } }, 'an Any whose type its definitions do not hold'],
    [
      {
        any: {
          typeUrl: 'type.googleapis.com/bead.transcoding.v1.Inner',
          value: Uint8Array.of(0xff),
        },
      },
      'an Any whose bytes do not read as its type',
    ],
  ] as const) {
    try {
      writeProtoJson(EdgesSchema, { message: create(EdgesSchema, init), registry: REGISTRY });
      parted.push(`${JSON.stringify(Object.keys(init))}: written, where ${words}`);
    } catch (error) {
      if (!(error instanceof JsonFormError)) {
        throw error;
      }

      if (error.reason !== words) {
        parted.push(`${JSON.stringify(Object.keys(init))}: ${error.reason}, where ${words}`);
      }
    }
  }

  expect(parted).toEqual([]);
});

test('reads and writes an Any of a wrapper by its value, and a wrapper alone as its scalar', () => {
  const packed = `{"any":{"@type":"${INT32_VALUE_URL}","value":3}}`;
  const edges = readEdges(`{"any":{"@type":"${INT64_VALUE_URL}","value":"7"}}`);

  // * a wrapper in an Any under value, as its scalar
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
  expect(fromBinary(Int32ValueSchema, readEdges(packed).any?.value ?? new Uint8Array()).value).toBe(
    3
  );
  expect(
    writeEdges({
      any: {
        typeUrl: INT32_VALUE_URL,
        value: toBinary(Int32ValueSchema, create(Int32ValueSchema, { value: 3 })),
      },
    })
  ).toBe(packed);

  // a wrapper alone, read and written as its scalar, at its default too
  expect(
    readProtoJson(Int32ValueSchema, { bytes: ENCODER.encode('3'), registry: REGISTRY })
  ).toMatchObject({ value: 3 });
  expect(
    writeProtoJson(Int32ValueSchema, {
      message: create(Int32ValueSchema, { value: 3 }),
      registry: REGISTRY,
    })
  ).toBe('3');
  expect(
    writeProtoJson(StringValueSchema, {
      message: create(StringValueSchema, { value: 'a' }),
      registry: REGISTRY,
    })
  ).toBe('"a"');
  expect(
    writeProtoJson(Int32ValueSchema, { message: create(Int32ValueSchema), registry: REGISTRY })
  ).toBe('0');
  expect(
    writeProtoJson(Int64ValueSchema, {
      message: create(Int64ValueSchema, { value: -3n }),
      registry: REGISTRY,
    })
  ).toBe('"-3"');
});

test('writes each kind of Value, and a Struct within a Struct, in its own form', () => {
  const kindOf = (value: null | boolean | string): MessageInitShape<typeof ValueSchema> => {
    if (value === null) {
      return { kind: { case: 'nullValue', value: 0 } };
    }

    return typeof value === 'boolean'
      ? { kind: { case: 'boolValue', value } }
      : { kind: { case: 'stringValue', value } };
  };

  // * each kind, a Struct's members sorted, one within another
  expect(writeEdges({ value: kindOf(false) })).toBe('{"value":false}');
  expect(writeEdges({ value: kindOf(null) })).toBe('{"value":null}');
  expect(writeEdges({ extra: { s: { b: 1.5, a: null }, l: ['x', true, false] } })).toBe(
    '{"extra":{"l":["x",true,false],"s":{"a":null,"b":1.5}}}'
  );
  expect(
    writeEdges({
      value: {
        kind: {
          case: 'structValue',
          value: {
            fields: {
              a: {
                kind: {
                  case: 'listValue',
                  value: { values: [kindOf(null), kindOf('b'), kindOf(true)] },
                },
              },
            },
          },
        },
      },
    })
  ).toBe('{"value":{"a":[null,"b",true]}}');
  expect(
    writeEdges({
      value: { kind: { case: 'structValue', value: { fields: { b: kindOf('x') } } } },
    })
  ).toBe('{"value":{"b":"x"}}');
  expect(writeEdges({ extra: { a: { b: 1, c: [] } } })).toBe('{"extra":{"a":{"b":1,"c":[]}}}');

  // a Value of no kind, which its form holds none of
  expect(() => {
    return writeEdges({ value: {} });
  }).toThrow('a Value that holds no kind');
});

test('writes a message nested 100 deep, and refuses one nested past 100', () => {
  // * 100 below the result written; 101 refused, a Struct's members counted as a message's
  expect(
    writeProtoJson(EdgesSchema, {
      message: create(EdgesSchema, nestedEdges(100)),
      registry: REGISTRY,
    })
  ).toMatch(/^\{"child":\{"child":/u);
  expect(() => {
    return writeProtoJson(EdgesSchema, {
      message: create(EdgesSchema, nestedEdges(101)),
      registry: REGISTRY,
    });
  }).toThrow('a message nested past 100');

  let structured: MessageInitShape<typeof EdgesSchema> = { extra: { a: 1 } };

  for (let index = 0; index < 99; index += 1) {
    structured = { child: structured };
  }

  expect(() => {
    return writeProtoJson(EdgesSchema, {
      message: create(EdgesSchema, structured),
      registry: REGISTRY,
    });
  }).toThrow('a message nested past 100');
});

test('writes an unset 64-bit oneof field as zero in a response body', () => {
  for (const message of [
    create(PatchProfileSchema),
    create(PatchProfileSchema, { selection: { case: 'label', value: 'Ada' } }),
  ]) {
    for (const name of ['count', 'string_count']) {
      expect(writeFieldJson(PatchProfileSchema, { message, name, registry: REGISTRY })).toBe('"0"');
    }
  }
});

test('writes a response body’s field at its default where its oneof holds another member or none', () => {
  const fieldOf = (schema: DescMessage, init: { message: Message; name: string }): string => {
    return writeFieldJson(schema, { ...init, registry: REGISTRY });
  };
  const edges = create(EdgesSchema);
  const everything = create(EverythingSchema);

  // * a message field unset is its empty message, a wrapper's its value's zero, a scalar its zero
  expect(fieldOf(EdgesSchema, { message: edges, name: 'child' })).toBe('{}');
  expect(fieldOf(EdgesSchema, { message: edges, name: 'wrapped_float' })).toBe('0');
  expect(fieldOf(EdgesSchema, { message: edges, name: 'wrapped_int64' })).toBe('"0"');
  expect(fieldOf(EverythingSchema, { message: everything, name: 'wrapped_bool' })).toBe('false');
  expect(fieldOf(EverythingSchema, { message: everything, name: 'wrapped_string' })).toBe('""');
  expect(fieldOf(EdgesSchema, { message: edges, name: 'ints' })).toBe('[]');
  expect(fieldOf(EdgesSchema, { message: edges, name: 'labels' })).toBe('{}');
  expect(fieldOf(EdgesSchema, { message: edges, name: 'an_int32' })).toBe('0');
  expect(
    fieldOf(EverythingSchema, {
      message: create(EverythingSchema, { inner: { name: 'a' } }),
      name: 'inner',
    })
  ).toBe('{"name":"a"}');
  expect(
    fieldOf(ListBooksResponseSchema, { message: create(ListBooksResponseSchema), name: 'books' })
  ).toBe('[]');

  // a oneof's member set, another of it at its default, and each of none at its default
  const chosen = create(EverythingSchema, { choice: { case: 'choiceText', value: 'x' } });

  expect(fieldOf(EverythingSchema, { message: chosen, name: 'choice_text' })).toBe('"x"');
  expect(fieldOf(EverythingSchema, { message: chosen, name: 'choice_inner' })).toBe('{}');
  expect(fieldOf(EverythingSchema, { message: everything, name: 'choice_text' })).toBe('""');
  expect(fieldOf(EverythingSchema, { message: everything, name: 'inner' })).toBe('{}');
  expect(fieldOf(EdgesSchema, { message: edges, name: 'null_member' })).toBe('null');
  expect(fieldOf(ValueSchema, { message: create(ValueSchema), name: 'number_value' })).toBe('0');
  expect(fieldOf(ValueSchema, { message: create(ValueSchema), name: 'bool_value' })).toBe('false');

  // * a response_body names its field by its proto name, as http.proto does: a JSON name, or none,
  // is its caller's bug, which a route's builder refuses
  for (const name of ['choiceText', 'nope']) {
    expect(() => {
      return fieldOf(EverythingSchema, { message: everything, name });
    }).toThrow(ProgrammerError);
  }
});

test('writes a field of its own presence where it is set, at its default too, and leaves it out unset', () => {
  expect(
    writeProtoJson(EverythingSchema, { message: create(EverythingSchema), registry: REGISTRY })
  ).toBe('{}');
  expect(
    writeProtoJson(EverythingSchema, {
      message: create(EverythingSchema, { aString: '', maybe: 0 }),
      registry: REGISTRY,
    })
  ).toBe('{"maybe":0}');

  // TypeScript alone: edition 2023's explicit presence, `explicit` and `needed`, and `implicit` of
  // its own, on a message of the validations' definitions, which the C# side's transcoding tests
  // do not build
  const registry = typeRegistryOf([PresenceSchema]);

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
