// ── Codec ─────────────────────────────────────────────────────────────────────

// A `proto` payload's one codec of its schema (decisions 0028, 0031 and 0042): spec 17.9 held once,
// on reading and on writing, wherever the runtime reads or writes a message, its writer writing
// nothing its reader refuses (17.2).

// dependencies

import {
  create,
  type DescMessage,
  fromBinary,
  type MessageInitShape,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import { type IPayloadCodec, payloadCodecOf } from '../router/shared/payloads';
import { assertProtoDepth } from './depth';
import { checkProtoRecords, filtered, PROTO_REASONS } from './records';
import { type RequiredPath, unsetNameOf, unsetPathOf } from './required';

// constants

// ! protobuf-es counts the top message: 101 is spec 17.9.3's 100 below it
const RECURSION_LIMIT = 101;

// helpers

/** What a refusal of a message that leaves a required field unset found, by the schema's names. */
const unsetWordsOf = (path: RequiredPath): string => {
  return `a proto message leaves ${unsetNameOf(path)} unset`;
};

/**
 * `bytes`, written of `schema`, checked as its reader checks them (spec 17.2): what it refuses, the
 * writer refuses, a `TypeError` of the same reason, the reader's refusal its cause. Past the depth
 * pass, it refuses what a reading kept nesting past the bound, an unknown group or an extension's
 * message.
 */
const readBack = (bytes: Uint8Array, schema: DescMessage): Uint8Array => {
  try {
    checkProtoRecords(bytes, schema);
  } catch (reason) {
    throw reason instanceof SyntaxError ? new TypeError(reason.message, { cause: reason }) : reason;
  }

  return bytes;
};

/**
 * `bytes` read as `schema` as spec 17.9 reads a payload but for its item 7: the records checked, a
 * singular closed enum's undeclared number dropped before protobuf-es reads, as every side drops it
 * (17.9.8), then protobuf-es's reader within `recursionLimit`. An `Any`'s bytes are read so, which
 * 17.9.7 does not look into.
 * What does not read throws a `SyntaxError`, the refusal of every codec's reader, of its reason,
 * `nested past 100` or `not its message`, protobuf-es's own error or the record refused its
 * `cause`.
 */
export const readProtoBytes = <Desc extends DescMessage>(
  schema: Desc,
  { bytes, recursionLimit }: { bytes: Uint8Array; recursionLimit: number }
): MessageShape<Desc> => {
  const read = filtered(bytes, schema);

  // ! protobuf-es throws a TypeError on a string that is not UTF-8, and a plain Error elsewhere:
  // what the stock reader throws as it reads is spec 17.9's refusal, never the side's own error
  try {
    return fromBinary(schema, read, { recursionLimit });
  } catch (reason) {
    throw new SyntaxError(PROTO_REASONS.notItsMessage, { cause: reason });
  }
};

// definition

/**
 * The codec of a `proto` payload of `schema`, as generated code holds one: its reader checks the
 * records against the schema (`checkProtoRecords`), drops a singular closed enum's undeclared
 * number (17.9.8), reads them with protobuf-es within spec 17.9.3's bound, then refuses a message
 * that leaves a field of `LEGACY_REQUIRED` presence unset (17.9.7), each refusal a `SyntaxError`.
 * Its writer refuses, with a `TypeError`, a value whose known fields nest past the bound before
 * anything is built of it, then builds the message of what it is given and refuses one that leaves
 * such a field unset, writes it, and checks the bytes as its reader does, so it writes nothing its
 * reader refuses (17.2). A refusal's message is its reason in 17.2's words, `not its message`,
 * `nested past 100` or `a required field unset`, the field's name or the record refused in its
 * `cause`. The walk looks into every message the payload holds but an extension's and an `Any`'s.
 *
 * @example
 * import { protoCodecOf } from '@francisdesjardins/bead/proto';
 *
 * const sayHelloRequest = protoCodecOf(SayHelloRequestSchema);
 * const bytes = sayHelloRequest.encode({ name: 'Ada' });
 */
export const protoCodecOf = <Desc extends DescMessage>(
  schema: Desc
): IPayloadCodec<MessageShape<Desc>, MessageInitShape<Desc>> => {
  return payloadCodecOf<MessageShape<Desc>, MessageInitShape<Desc>>({
    decode: (bytes) => {
      const message = readProtoBytes(schema, { bytes, recursionLimit: RECURSION_LIMIT });
      const unset = unsetPathOf(schema, message);

      if (unset !== undefined) {
        throw new SyntaxError(PROTO_REASONS.requiredUnset, {
          cause: new SyntaxError(unsetWordsOf(unset)),
        });
      }

      return message;
    },
    encode: (given) => {
      // ! the depth pass first, on the value as given: past it, neither protobuf-es's create nor
      // its writer nor the required walk recurses past the bound
      assertProtoDepth(schema, given);

      const message = create(schema, given);
      const unset = unsetPathOf(schema, message);

      // * before protobuf-es's own check, which throws a plain Error and only on writing
      if (unset !== undefined) {
        throw new TypeError(PROTO_REASONS.requiredUnset, {
          cause: new TypeError(unsetWordsOf(unset)),
        });
      }

      return readBack(toBinary(schema, message), schema);
    },
  });
};
