// ── Fuzz target: the proto codecs ─────────────────────────────────────────────

// The `proto` codec over `spec/codecs.proto`'s `Probe` (spec 17.9). The input's first byte draws a
// path, a child, a map's entry or a group; its second a count, 0 to 127; its third a number of
// unknown groups, 0 to 127. The rest, wrapped in that many groups of field 4, which `Probe` does not
// declare, is read: a refusal, a `SyntaxError`, passes. A message that reads is wrapped `count`
// times on its path, then written: its writer refuses it, a `TypeError` of `nested past 100`, or
// its reader takes what it wrote (17.2), which equals the message as protobuf-es compares messages
// and writes again to the same bytes, but where a reading kept a singular closed enum's undeclared
// number among its unknown fields, which protobuf-es writes back otherwise, as the support matrix's
// row of it says. The C# side's `ProtoCodecsTarget` and the Rust side's `proto-codecs` are its twins.

// dependencies

import { create, equals } from '@bufbuild/protobuf';
import { type ReflectMessage, reflect } from '@bufbuild/protobuf/reflect';
import { protoCodecOf } from '../../src/proto/codec';
import { type Probe, ProbeSchema } from '../../src/router/shared/__tests__/codecs_pb';
import { hexadecimalOf, isRefused } from './refusal';

// constants

// a group of field 4, opened and closed (Encoding, "Groups")
const START = 0x23;
const END = 0x24;

const PROBE = protoCodecOf(ProbeSchema);

// helpers

/** A `Probe` that holds `inner` on the path `path` draws: as its child, as an entry's value under the key "", or as its group. */
const wrapped = (inner: Probe, path: number): Probe => {
  switch (path % 3) {
    case 0:
      return create(ProbeSchema, { child: inner });
    case 1:
      return create(ProbeSchema, { children: { '': inner } });
    default:
      return create(ProbeSchema, { delimited: inner });
  }
};

/**
 * Whether `message`, or a message it holds, keeps a singular closed enum's undeclared number among
 * its unknown fields: protobuf-es's reader sets one there, and replaces it with the message's other
 * unknown fields where it holds any, so what it writes reads back and is written otherwise.
 */
const keepsAnUndeclaredNumber = (message: ReflectMessage): boolean => {
  const kept = new Set(
    (message.getUnknown() ?? []).map(({ no }) => {
      return no;
    })
  );

  return message.fields.some((field) => {
    switch (field.fieldKind) {
      case 'enum':
        return kept.has(field.number);
      case 'message':
        return message.isSet(field) && keepsAnUndeclaredNumber(message.get(field));
      case 'list':
        return (
          field.listKind === 'message' &&
          [...message.get(field)].some((item) => {
            return keepsAnUndeclaredNumber(item as ReflectMessage);
          })
        );
      case 'map':
        return (
          field.mapKind === 'message' &&
          [...message.get(field)].some(([, value]) => {
            return keepsAnUndeclaredNumber(value as ReflectMessage);
          })
        );
      case 'scalar':
        return false;
    }
  });
};

const isSame = (one: Uint8Array, other: Uint8Array): boolean => {
  return Buffer.from(one).equals(Buffer.from(other));
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const [path = 0, count = 0, groups = 0] = data;

  if (data.length < 3) {
    return;
  }

  const bytes = Uint8Array.from([
    ...Array.from({ length: groups % 128 }, () => {
      return START;
    }),
    ...data.subarray(3),
    ...Array.from({ length: groups % 128 }, () => {
      return END;
    }),
  ]);
  let message: Probe | undefined;

  isRefused(SyntaxError, () => {
    message = PROBE.decode(bytes);
  });

  if (message === undefined) {
    return;
  }

  for (let above = 0; above < count % 128; above += 1) {
    message = wrapped(message, path);
  }

  let written: Uint8Array | undefined;

  try {
    written = PROBE.encode(message);
  } catch (reason) {
    // * the writer refuses for its depth alone: any other refusal, or error, is a finding
    if (!(reason instanceof TypeError) || reason.message !== 'nested past 100') {
      throw reason;
    }

    return;
  }

  const read = PROBE.decode(written);

  if (!equals(ProbeSchema, read, message)) {
    throw new Error(`a proto message reads back otherwise: ${hexadecimalOf(data)}`);
  }

  // * protobuf-es's echo of a closed enum's undeclared number, the matrix's row, is no finding
  if (
    !isSame(PROBE.encode(read), written) &&
    !keepsAnUndeclaredNumber(reflect(ProbeSchema, message))
  ) {
    throw new Error(`a proto message is written again otherwise: ${hexadecimalOf(data)}`);
  }
};
