// ── Codec ─────────────────────────────────────────────────────────────────────

// The runtime's codec of a `proto` payload's schema: a required field unset both ways (spec
// 17.9.7), a closed enum's undeclared number (17.9.8) and a writer's bound (17.2, 17.9.3). The C#
// side's `ProtoCodecsTests` and the Rust side's `codec/tests.rs` play the same sentences.

// dependencies

import {
  create,
  createFileRegistry,
  type DescExtension,
  type DescMessage,
  getExtension,
  isFieldSet,
  type JsonObject,
  type Message,
  type MessageInitShape,
  setExtension,
} from '@bufbuild/protobuf';
import { reflect } from '@bufbuild/protobuf/reflect';
import {
  AnySchema,
  Edition,
  FeatureSet_EnumType,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
  ListValueSchema,
  type Value,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';
import { type Probe, ProbeSchema, type Shade } from '../../router/shared/__tests__/codecs_pb';
import { EdgesSchema, RequiringSchema } from '../../transcoding/__tests__/generated/transcoding_pb';
import {
  NeedsSchema,
  NeedsUpdateSchema,
} from '../../transcoding/__tests__/generated/transcoding-required_pb';
import { protoCodecOf } from '../codec';
import { nestsPastOf, requiredShapeOf } from '../records';
import { unsetPathOf } from '../required';

// constants

const OPTIONAL = FieldDescriptorProto_Label.OPTIONAL;
const REQUIRED = FieldDescriptorProto_Label.REQUIRED;

/**
 * A proto2 file of what neither `Probe` nor `Requiring` holds: a oneof of a closed enum, an
 * extension of a message that requires a field, and a cycle through a message that reaches one
 * (`Loop` holds `Back`, which holds `Loop` and `Must`), beside one that reaches none (`Alone`).
 */
const FILE = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    enumType: [
      {
        name: 'Tone',
        value: [
          { name: 'TONE_LOW', number: 0 },
          { name: 'TONE_HIGH', number: 1 },
        ],
      },
    ],
    extension: [
      {
        extendee: '.bead.test.Holder',
        jsonName: 'inner',
        label: OPTIONAL,
        name: 'inner',
        number: 100,
        type: FieldDescriptorProto_Type.MESSAGE,
        typeName: '.bead.test.Must',
      },
    ],
    messageType: [
      {
        field: [
          {
            jsonName: 'tone',
            label: OPTIONAL,
            name: 'tone',
            number: 1,
            oneofIndex: 0,
            type: FieldDescriptorProto_Type.ENUM,
            typeName: '.bead.test.Tone',
          },
          {
            jsonName: 'word',
            label: OPTIONAL,
            name: 'word',
            number: 2,
            oneofIndex: 0,
            type: FieldDescriptorProto_Type.STRING,
          },
        ],
        name: 'Toned',
        oneofDecl: [{ name: 'pick' }],
      },
      { extensionRange: [{ end: 201, start: 100 }], name: 'Holder' },
      {
        field: [
          {
            jsonName: 'must',
            label: REQUIRED,
            name: 'must',
            number: 1,
            type: FieldDescriptorProto_Type.INT32,
          },
        ],
        name: 'Must',
      },
      {
        field: [
          {
            jsonName: 'back',
            label: OPTIONAL,
            name: 'back',
            number: 1,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: '.bead.test.Back',
          },
        ],
        name: 'Loop',
      },
      {
        field: [
          {
            jsonName: 'loop',
            label: OPTIONAL,
            name: 'loop',
            number: 1,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: '.bead.test.Loop',
          },
          {
            jsonName: 'must',
            label: OPTIONAL,
            name: 'must',
            number: 2,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: '.bead.test.Must',
          },
        ],
        name: 'Back',
      },
      {
        field: [
          {
            jsonName: 'alone',
            label: OPTIONAL,
            name: 'alone',
            number: 1,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: '.bead.test.Alone',
          },
        ],
        name: 'Alone',
      },
    ],
    name: 'bead/test/codec.proto',
    package: 'bead.test',
    syntax: 'proto2',
  }),
  () => {
    return undefined;
  }
);

/** A message of the file written here, by its name in `bead.test`. */
const messageOf = (name: string): DescMessage => {
  const message = FILE.getMessage(`bead.test.${name}`);

  if (message === undefined) {
    throw new Error(`no message ${name}`);
  }

  return message;
};

// helpers

/** The codec of a singular enum field nested through three edition messages. */
const editionCodec = (options: {
  file?: FeatureSet_EnumType;
  outer?: FeatureSet_EnumType;
  inner?: FeatureSet_EnumType;
  holder?: number;
}) => {
  const registry = createFileRegistry(
    create(FileDescriptorProtoSchema, {
      name: 'edition.proto',
      package: 'edition',
      syntax: 'editions',
      edition: Edition.EDITION_2023,
      options:
        options.file === undefined
          ? options.holder === 1
            ? {}
            : options.holder === 2
              ? { features: {} }
              : undefined
          : { features: { enumType: options.file } },
      messageType: [
        {
          name: 'Outer',
          options:
            options.outer === undefined ? undefined : { features: { enumType: options.outer } },
          nestedType: [
            {
              name: 'Holder',
              options:
                options.holder === 1 ? {} : options.holder === 2 ? { features: {} } : undefined,
              nestedType: [
                {
                  name: 'Inner',
                  options:
                    options.inner === undefined
                      ? undefined
                      : { features: { enumType: options.inner } },
                  enumType: [
                    {
                      name: 'Tone',
                      value: [
                        { name: 'LOW', number: 0 },
                        { name: 'HIGH', number: 1 },
                      ],
                    },
                  ],
                  field: [
                    {
                      name: 'tone',
                      jsonName: 'tone',
                      number: 1,
                      label: OPTIONAL,
                      type: FieldDescriptorProto_Type.ENUM,
                      typeName: '.edition.Outer.Holder.Inner.Tone',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
    () => {
      return undefined;
    }
  );
  const schema = registry.getMessage('edition.Outer.Holder.Inner');
  if (schema === undefined) {
    throw new Error('no edition message');
  }
  const codec = protoCodecOf(schema);
  const field = schema.field['tone']!;

  return (closed: boolean) => {
    const unknown = codec.decode(bytesOf('08 05'));
    const last = codec.decode(bytesOf('08 01 08 05'));

    expect(isFieldSet(unknown, field)).toBe(!closed);
    expect(reflect(schema, unknown).get(field)).toBe(closed ? 0 : 5);
    expect(reflect(schema, last).get(field)).toBe(closed ? 1 : 5);
    expect(reflect(schema, codec.decode(bytesOf('08 01'))).get(field)).toBe(1);
  };
};

test('resolves an edition enum from its nearest message before its file', () => {
  const { CLOSED, OPEN } = FeatureSet_EnumType;
  editionCodec({ file: CLOSED, outer: CLOSED, inner: OPEN })(false);
  editionCodec({ file: OPEN, outer: OPEN, inner: CLOSED })(true);
  for (const holder of [0, 1, 2]) {
    editionCodec({ file: OPEN, outer: CLOSED, holder })(true);
    editionCodec({ file: CLOSED, outer: OPEN, holder })(false);
  }
});

test('resolves an edition enum from its file when no message sets its type', () => {
  for (const holder of [0, 1, 2]) {
    editionCodec({ file: FeatureSet_EnumType.CLOSED, holder })(true);
    editionCodec({ file: FeatureSet_EnumType.OPEN, holder })(false);
  }
});

test('opens an edition enum when no message or file sets its type', () => {
  for (const holder of [0, 1, 2]) {
    editionCodec({ holder })(false);
  }
});

/** The bytes of `hex`, two digits each, a space between. */
const bytesOf = (hex: string): Uint8Array => {
  return Uint8Array.from(hex.split(' ').filter(Boolean), (pair) => {
    return Number.parseInt(pair, 16);
  });
};

/** `bytes` as `bytesOf` reads them. */
const hexOf = (bytes: Uint8Array): string => {
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).toUpperCase().padStart(2, '0');
    })
    .join(' ');
};

/** What `act` throws; none when it returns. */
const thrownBy = (act: () => unknown): unknown => {
  try {
    act();
  } catch (error) {
    return error;
  }

  return undefined;
};

/**
 * 60 groups of field 4, which `Probe` does not declare, one in another: what a reading keeps among
 * its unknown fields, the same bytes on every side.
 */
const GROUPS = `${'23 '.repeat(60)}${'24 '.repeat(60)}`.trim();

/** `count` messages above `deepest`, each holding the one below as `link` does, built from the deepest up. */
const wrapped = <Held>(
  deepest: Held,
  { count, link }: { count: number; link: (inner: Held) => Held }
): Held => {
  let held = deepest;

  for (let above = 0; above < count; above += 1) {
    held = link(held);
  }

  return held;
};

/** A `Probe` that holds `inner` as its child. */
const childOf = (inner: Probe): Probe => {
  return create(ProbeSchema, { child: inner });
};

/** Holds that `codec` writes `value` and reads back what it wrote. */
const expectWritten = <Desc extends DescMessage>(
  codec: ReturnType<typeof protoCodecOf<Desc>>,
  { value, what }: { value: MessageInitShape<Desc>; what: string }
): void => {
  const thrown = thrownBy(() => {
    return codec.decode(codec.encode(value));
  });

  expect(thrown, what).toBeUndefined();
};

/** Holds that `codec` refuses to write `value` for its depth: a `TypeError` of `nested past 100`. */
const expectNestedPast = <Desc extends DescMessage>(
  codec: ReturnType<typeof protoCodecOf<Desc>>,
  { value, what }: { value: MessageInitShape<Desc>; what: string }
): void => {
  const thrown = thrownBy(() => {
    return codec.encode(value);
  });

  expect(
    [(thrown as Error | undefined)?.constructor, (thrown as Error | undefined)?.message],
    what
  ).toEqual([TypeError, 'nested past 100']);
};

/** What a refusal says: its reason, then the field its cause names where it names one. */
const saidOf = (thrown: unknown): string => {
  const cause = ((thrown as Error).cause as Error | undefined)?.message ?? '';
  const named = /^a proto message leaves (?<name>\S+) unset$/u.exec(cause)?.groups?.['name'];

  return `${(thrown as Error).message}: ${named ?? cause}`;
};

/** What the refusal of a message that leaves the field `name` unset says, as `saidOf` has it. */
const wordsOf = (name: string): string => {
  return `a required field unset: ${name}`;
};

// definition

test.describe("a proto payload's codec of its schema", () => {
  test('refuses a message that leaves a required field unset at every depth: a proto3 root’s message, an item, a map’s value, a group and a delimited field', () => {
    const requiring = protoCodecOf(RequiringSchema);
    const probe = protoCodecOf(ProbeSchema);

    for (const [codec, hex, name] of [
      // its needs, {count: 1}
      [requiring, '0A 02 10 01', 'bead.transcoding.v1.Needs.name'],
      // an item of many, the second, {name: "a"}
      [requiring, '12 04 0A 00 10 00 12 03 0A 01 61', 'bead.transcoding.v1.Needs.count'],
      // a value of by_key, at "k", {count: 1}
      [requiring, '1A 07 0A 01 6B 12 02 10 01', 'bead.transcoding.v1.Needs.name'],
      // Probe's delimited, a group, whose needs is {must: 0}
      [probe, '6B 3A 02 08 00 6C', 'bead.codecs.v1.Needs.shade'],
      // its needs' delimited, {count: 1}
      [requiring, '0A 09 0A 01 61 10 01 23 10 01 24', 'bead.transcoding.v1.Needs.name'],
    ] as const) {
      const thrown = thrownBy(() => {
        return codec.decode(bytesOf(hex));
      });

      expect(thrown, hex).toBeInstanceOf(SyntaxError);
      expect(saidOf(thrown), hex).toBe(wordsOf(name));
    }
  });

  test('refuses a payload with a SyntaxError and a value with a TypeError, in the same words', () => {
    const needs = protoCodecOf(NeedsSchema);
    const read = thrownBy(() => {
      return needs.decode(bytesOf('10 01'));
    });
    const written = thrownBy(() => {
      return needs.encode({ count: 1 });
    });

    expect(read).toBeInstanceOf(SyntaxError);
    expect(written).toBeInstanceOf(TypeError);
    expect(saidOf(read)).toBe(wordsOf('bead.transcoding.v1.Needs.name'));
    expect(saidOf(written)).toBe(saidOf(read));
    // * a closed enum's number its enum does not declare is no value of a required field
    expect(
      saidOf(
        thrownBy(() => {
          return protoCodecOf(ProbeSchema).encode({ needs: { must: 0, shade: 5 as Shade } });
        })
      )
    ).toBe(wordsOf('bead.codecs.v1.Needs.shade'));
  });

  test('refuses bytes its library cannot read as every reader refuses, the library’s error as its cause', () => {
    // a text of one byte that is not UTF-8, which protobuf-es reads, past the records' check
    const thrown = thrownBy(() => {
      return protoCodecOf(ProbeSchema).decode(bytesOf('0A 01 FF'));
    });

    // * its reason 17.2's words, protobuf-es's error its cause
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect((thrown as Error).message).toBe('not its message');
    expect((thrown as Error).cause).toBeInstanceOf(TypeError);
  });

  test('takes a required field set at its default, and one a message given twice sets in either record', () => {
    const needs = protoCodecOf(NeedsSchema);
    const requiring = protoCodecOf(RequiringSchema);

    expect(needs.decode(bytesOf('0A 00 10 00'))).toMatchObject({ count: 0, name: '' });
    expect(hexOf(needs.encode({ count: 0, name: '' }))).toBe('0A 00 10 00');

    for (const hex of [
      '0A 04 0A 00 10 00 0A 00',
      '0A 00 0A 04 0A 00 10 00',
      '0A 02 0A 00 0A 02 10 00',
    ]) {
      expect(requiring.decode(bytesOf(hex)).needs, hex).toMatchObject({ count: 0, name: '' });
    }
  });

  test('reads a closed enum’s undeclared number as setting nothing, its last declared number kept, a oneof’s other member too', () => {
    const probe = protoCodecOf(ProbeSchema);
    const nothing = probe.decode(bytesOf('70 05'));
    const kept = probe.decode(bytesOf('70 01 70 05'));
    const toned = protoCodecOf(messageOf('Toned')).decode(bytesOf('12 01 61 08 05')) as unknown as {
      pick: { case: string | undefined; value?: unknown };
    };

    expect(isFieldSet(nothing, ProbeSchema.field.shade)).toBe(false);
    expect(kept.shade).toBe(1);
    expect(toned.pick).toEqual({ case: 'word', value: 'a' });
    // * kept among the unknown fields, which protobuf-es writes back where the message holds no other
    expect(hexOf(probe.encode(kept))).toBe('70 01 70 05');
  });

  test('echoes a closed enum’s undeclared number beside another unknown field, and a wide one, as its library keeps them', () => {
    const probe = protoCodecOf(ProbeSchema);
    const beside = probe.decode(bytesOf('70 05 20 01'));
    const wide = probe.decode(bytesOf('70 FF FF FF FF 0F'));

    expect(isFieldSet(beside, ProbeSchema.field.shade)).toBe(false);
    expect(isFieldSet(wide, ProbeSchema.field.shade)).toBe(false);
    // ! a matrix row: protobuf-es's reader replaces the number it set among the unknown fields
    // with the message's other unknown fields, so the number is dropped
    expect(hexOf(probe.encode(beside))).toBe('20 01');
    // ! a matrix row: written again as an int32 varint, a number past 31 bits in ten bytes
    // (Encoding, "Signed Integers")
    expect(hexOf(probe.encode(wide))).toBe('70 FF FF FF FF FF FF FF FF FF 01');
  });

  test('looks into no extension and no Any’s message', () => {
    const requiring = protoCodecOf(RequiringSchema);
    const holder = protoCodecOf(messageOf('Holder'));
    const extension = FILE.getExtension('bead.test.inner') as DescExtension;
    const partial = {
      any: create(AnySchema, {
        typeUrl: 'type.googleapis.com/bead.transcoding.v1.Needs',
        value: bytesOf('10 01'),
      }),
    };
    // its any, a Needs of {count: 1}
    const packed =
      '22 33 0A 2D 74 79 70 65 2E 67 6F 6F 67 6C 65 61 70 69 73 2E 63 6F 6D 2F 62 65 61 64 2E 74 72 61 6E 73 63 6F 64 69 6E 67 2E 76 31 2E 4E 65 65 64 73 12 02 10 01';

    expect(hexOf(requiring.encode(partial))).toBe(packed);
    expect(requiring.decode(bytesOf(packed)).any?.value).toEqual(bytesOf('10 01'));

    // an extension's Must of no field, which every side reads as an unknown field
    const read = holder.decode(bytesOf('A2 06 00'));

    expect(getExtension(read, extension)).toMatchObject({ $typeName: 'bead.test.Must' });
    expect(hexOf(holder.encode(read))).toBe('A2 06 00');
    // ! a matrix row: protobuf-es refuses such a message as it sets it, where Google.Protobuf writes it
    expect(
      thrownBy(() => {
        setExtension(create(messageOf('Holder')), extension, create(messageOf('Must')));
      })
    ).toBeInstanceOf(Error);
  });

  test('walks nothing of a message that reaches no required field, cycles included', () => {
    // * Edges holds itself, and Alone too: neither reaches one
    expect(requiredShapeOf(EdgesSchema)).toBeUndefined();
    expect(requiredShapeOf(messageOf('Alone'))).toBeUndefined();
    expect(unsetPathOf(EdgesSchema, create(EdgesSchema, { child: { child: {} } }))).toBeUndefined();

    // * searched from Back first, through Loop and back: each reaches Must
    expect(
      requiredShapeOf(messageOf('Back'))?.holders.map(({ name }) => {
        return name;
      })
    ).toEqual(['loop', 'must']);
    expect(
      requiredShapeOf(messageOf('Loop'))?.holders.map(({ name }) => {
        return name;
      })
    ).toEqual(['back']);
    expect(
      unsetPathOf(
        messageOf('Loop'),
        create(messageOf('Loop'), { back: { loop: { back: { must: {} } } } })
      )?.map((step) => {
        return typeof step === 'object' ? step.name : step;
      })
    ).toEqual(['back', 'loop', 'back', 'must', 'must']);
  });

  test('refuses a message that leaves an edition’s required message field unset, reading and writing', () => {
    const update = protoCodecOf(NeedsUpdateSchema);
    const words = wordsOf('bead.transcoding.v1.NeedsUpdate.update_mask');
    const read = thrownBy(() => {
      return update.decode(bytesOf(''));
    });
    const written = thrownBy(() => {
      return update.encode({});
    });

    expect(read).toBeInstanceOf(SyntaxError);
    expect(saidOf(read)).toBe(words);
    expect(written).toBeInstanceOf(TypeError);
    expect(saidOf(written)).toBe(words);
    // its mask given, empty
    expect(hexOf(update.encode(update.decode(bytesOf('12 00'))))).toBe('12 00');
  });
});

// spec 17.2, 17.9.3: a writer refuses what its reader would refuse for its depth
test.describe("a proto payload's codec of its schema, writing within the bound", () => {
  test('refuses to write a message nested more than 100 deep below the top one, through a child, a group and a map’s entry', () => {
    const probe = protoCodecOf(ProbeSchema);
    const links: [name: string, per: number, link: (inner: Probe) => Probe][] = [
      ['a child', 1, childOf],
      [
        'a group',
        1,
        (inner) => {
          return create(ProbeSchema, { delimited: inner });
        },
      ],
      [
        'a map’s entry',
        2,
        (inner) => {
          return create(ProbeSchema, { children: { '': inner } });
        },
      ],
    ];

    for (const [name, per, link] of links) {
      const count = 100 / per;

      expectWritten(probe, {
        value: wrapped(create(ProbeSchema), { count, link }),
        what: `${String(count)} through ${name}`,
      });
      expectNestedPast(probe, {
        value: wrapped(create(ProbeSchema), { count: count + 1, link }),
        what: `${String(count + 1)} through ${name}`,
      });
    }

    // * a map of scalars' entry is a message on the wire: 99 below the top, then its entry
    const tallied = create(ProbeSchema, { tallies: { a: 1 } });

    expectWritten(probe, {
      value: wrapped(tallied, { count: 99, link: childOf }),
      what: "a scalar map's entry at 100",
    });
    expectNestedPast(probe, {
      value: wrapped(tallied, { count: 100, link: childOf }),
      what: "a scalar map's entry at 101",
    });
  });

  test('refuses to write a message 101 deep that reaches no required field', () => {
    const schema = messageOf('Alone');
    const alone = protoCodecOf(schema);
    const link = (inner: Message): Message => {
      return create(schema, { alone: inner });
    };

    // * the required walk's shortcut skips Alone: the bound holds all the same
    expect(requiredShapeOf(schema)).toBeUndefined();
    expect(nestsPastOf(schema)).toBe(true);
    expectWritten(alone, { value: wrapped(create(schema), { count: 100, link }), what: '100' });
    expectNestedPast(alone, { value: wrapped(create(schema), { count: 101, link }), what: '101' });
  });

  test('refuses a value 10,000 deep before its library writes any of it', () => {
    const probe = protoCodecOf(ProbeSchema);
    const schema = messageOf('Alone');
    const given: MessageInitShape<typeof ProbeSchema> = wrapped<
      MessageInitShape<typeof ProbeSchema>
    >(
      {},
      {
        count: 10_000,
        link: (inner) => {
          return { child: inner };
        },
      }
    );

    // ! neither create nor toBinary reached: either recurses past the stack 10,000 deep
    expectNestedPast(probe, {
      value: wrapped(create(ProbeSchema), { count: 10_000, link: childOf }),
      what: 'a message',
    });
    expectNestedPast(probe, { value: given, what: 'its initializer' });
    expectNestedPast(protoCodecOf(schema), {
      value: wrapped(create(schema), {
        count: 10_000,
        link: (inner: Message) => {
          return create(schema, { alone: inner });
        },
      }),
      what: 'a message that reaches no required field',
    });
  });

  test('refuses to write 41 messages above 60 unknown groups a reading kept', () => {
    const probe = protoCodecOf(ProbeSchema);
    const read = probe.decode(bytesOf(GROUPS));

    // * the depth pass sees none of them: the check over the written bytes refuses, the reader's
    // refusal its cause
    expectWritten(probe, { value: wrapped(read, { count: 40, link: childOf }), what: '40' });
    expectNestedPast(probe, { value: wrapped(read, { count: 41, link: childOf }), what: '41' });
    expect(
      (
        thrownBy(() => {
          return probe.encode(wrapped(read, { count: 41, link: childOf }));
        }) as Error
      ).cause
    ).toBeInstanceOf(SyntaxError);
  });

  test('reads a map’s entry 100 deep that holds no value, and refuses to write the value its library gives it', () => {
    const probe = protoCodecOf(ProbeSchema);
    // `inner` as the bytes of a Probe's child, its field 3's record
    const childBytes = (inner: Uint8Array): Uint8Array => {
      const length: number[] = [];

      for (let left = inner.length; ; left >>>= 7) {
        if (left < 0x80) {
          length.push(left);

          break;
        }

        length.push((left & 0x7f) | 0x80);
      }

      return Uint8Array.from([0x1a, ...length, ...inner]);
    };

    // * 99 children below the top, the last holding an entry of children with no key and no value:
    // 100 deep on the wire, which a reader takes; its library gives the entry its value's default, a
    // message 101 deep, which its writer refuses
    const deepest = wrapped(Uint8Array.from([0x62, 0x00]), { count: 99, link: childBytes });

    expectNestedPast(probe, { value: probe.decode(deepest), what: 'an entry 100 deep, read' });

    const deeper = thrownBy(() => {
      return probe.decode(childBytes(deepest));
    }) as Error;

    expect([deeper.constructor, deeper.message], 'an entry 101 deep').toEqual([
      SyntaxError,
      'nested past 100',
    ]);
  });

  test('refuses to write a Struct nested past the bound, a member three messages deep', () => {
    const edges = protoCodecOf(EdgesSchema);
    // a JSON object `levels` deep, its innermost {"leaf": 1}: each level a Struct, its entry and a
    // Value, three messages
    const objectOf = (levels: number): JsonObject => {
      return wrapped<JsonObject>(
        { leaf: 1 },
        {
          count: levels - 1,
          link: (inner) => {
            return { k: inner };
          },
        }
      );
    };

    expectWritten(edges, { value: { extra: objectOf(33) }, what: 'a JSON object 33 deep' });
    expectNestedPast(edges, { value: { extra: objectOf(34) }, what: 'a JSON object 34 deep' });
  });

  test('refuses to write a Value nested past the bound through its lists', () => {
    const value = protoCodecOf(ValueSchema);
    // a Value of a list of one Value, that many lists deep, its innermost the number 1: each list
    // two messages, a ListValue and a Value, the ListValue a oneof's member
    const listed = (lists: number): Value => {
      return wrapped(create(ValueSchema, { kind: { case: 'numberValue', value: 1 } }), {
        count: lists,
        link: (inner) => {
          return create(ValueSchema, {
            kind: { case: 'listValue', value: create(ListValueSchema, { values: [inner] }) },
          });
        },
      });
    };

    expectWritten(value, { value: listed(50), what: '50 lists deep' });
    expectNestedPast(value, { value: listed(51), what: '51 lists deep' });
  });
});
