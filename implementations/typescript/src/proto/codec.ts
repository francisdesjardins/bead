// ── Codec ─────────────────────────────────────────────────────────────────────

// A `proto` payload's one codec of its schema (decisions 0028, 0031 and 0042): spec 17.9 held once,
// the records checked before protobuf-es reads them, its bound, the read, and the walk of a
// required field unset, on reading and on writing, wherever the runtime reads or writes a message.

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
import { checkProtoRecords } from './records';
import { type RequiredPath, unsetNameOf, unsetPathOf } from './required';

// constants

// ! protobuf-es counts the top message: 101 is spec 17.9.3's 100 below it
const RECURSION_LIMIT = 101;

// helpers

/** The words of a refusal of a message that leaves a required field unset, by the schema's names. */
const unsetWordsOf = (path: RequiredPath): string => {
  return `a proto message leaves ${unsetNameOf(path)} unset`;
};

/**
 * `bytes` read as `schema` as spec 17.9 reads a payload but for its item 7: the records checked,
 * then protobuf-es's reader within `recursionLimit`, which keeps a closed enum's undeclared number
 * among the unknown fields (17.9.8). An `Any`'s bytes are read so, which 17.9.7 does not look into.
 */
export const readProtoBytes = <Desc extends DescMessage>(
  schema: Desc,
  { bytes, recursionLimit }: { bytes: Uint8Array; recursionLimit: number }
): MessageShape<Desc> => {
  checkProtoRecords(bytes, schema);

  return fromBinary(schema, bytes, { recursionLimit });
};

// definition

/**
 * The codec of a `proto` payload of `schema`, as generated code holds one: its reader checks the
 * records against the schema (`checkProtoRecords`), reads them with protobuf-es within spec
 * 17.9.3's bound, then refuses a message that leaves a field of `LEGACY_REQUIRED` presence unset
 * (17.9.7) with a `SyntaxError`; its writer builds the message of what it is given, refuses one
 * that leaves such a field unset with a `TypeError`, in the same words, then writes it. The walk
 * looks into every message the payload holds but an extension's and an `Any`'s.
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
        throw new SyntaxError(unsetWordsOf(unset));
      }

      return message;
    },
    encode: (given) => {
      const message = create(schema, given);
      const unset = unsetPathOf(schema, message);

      // * before protobuf-es's own check, which throws a plain Error and only on writing
      if (unset !== undefined) {
        throw new TypeError(unsetWordsOf(unset));
      }

      return toBinary(schema, message);
    },
  });
};
