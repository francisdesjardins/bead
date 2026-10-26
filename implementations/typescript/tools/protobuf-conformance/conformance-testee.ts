// ── Protobuf conformance testee ───────────────────────────────────────────────

// The TypeScript side's testee of protobuf's conformance suite (decisions 0028 and 0037), as the
// suite's runner drives one: on the standard input, each ConformanceRequest after its length, a
// 32-bit little-endian integer; on the standard output, each ConformanceResponse alike, until the
// input ends. Each message is read and written back through the codec beadc generates for the
// procedure that binds it, found by the message's full name, so the check of its records runs before
// protobuf-es reads it, as it does in any project that binds proto; its JSON is read and written by
// Bead's own mapping, the transcoding layer's, so the suite tests the code a gateway answers by.
// `generated/` is what tools/protobuf-conformance.mjs generates at run time, never committed.

// dependencies

import type { DescMessage, Message, MessageInitShape } from '@bufbuild/protobuf';
import { toBinary } from '@bufbuild/protobuf';
import {
  JsonFormError,
  readProtoJson,
  typeRegistryOf,
  writeProtoJson,
} from '@francisdesjardins/bead/transcoding';

import { ProbeSchema } from './generated/codecs_pb.ts';
import type {
  ConformanceRequest,
  ConformanceResponseSchema,
} from './generated/conformance/conformance_pb.ts';
import { TestCategory, WireFormat } from './generated/conformance/conformance_pb.ts';
import { TestAllTypesEdition2023Schema } from './generated/protobuf_test_messages/test_messages_edition2023_pb.ts';
import { TestAllTypesProto2Schema as EditionsProto2Schema } from './generated/protobuf_test_messages/test_messages_proto2_editions_pb.ts';
import { TestAllTypesProto2Schema } from './generated/protobuf_test_messages/test_messages_proto2_pb.ts';
import { TestAllTypesProto3Schema as EditionsProto3Schema } from './generated/protobuf_test_messages/test_messages_proto3_editions_pb.ts';
import { TestAllTypesProto3Schema } from './generated/protobuf_test_messages/test_messages_proto3_pb.ts';
import { ConformanceProcedures } from './generated/service_bead.ts';

// interfaces

/** A procedure whose request and result are one message: read by the one, written by the other. */
interface IRoundTrip<Value> {
  readonly request: { readonly decode: (bytes: Uint8Array) => Value };
  readonly result: { readonly encode: (value: Value) => Uint8Array };
}

/** A message's schema, and its bytes read and written by its procedure's codec. */
interface ICodec {
  readonly schema: DescMessage;
  readonly decode: (bytes: Uint8Array) => Message;
  readonly encode: (message: Message) => Uint8Array;
}

// types

type Response = MessageInitShape<typeof ConformanceResponseSchema>;

// constants

const HEAD = 4;

// definition

const codecOf = <Value extends Message>(
  schema: DescMessage,
  procedure: IRoundTrip<Value>
): ICodec => {
  return {
    decode: (bytes) => {
      return procedure.request.decode(bytes);
    },
    encode: (message) => {
      return procedure.result.encode(message as Value);
    },
    schema,
  };
};

// each message the suite sends, by its full name: its schema, read from its bytes and written back
// to them by its procedure's codec
const CODECS: ReadonlyMap<string, ICodec> = new Map([
  [
    'protobuf_test_messages.proto3.TestAllTypesProto3',
    codecOf(TestAllTypesProto3Schema, ConformanceProcedures.proto3),
  ],
  [
    'protobuf_test_messages.proto2.TestAllTypesProto2',
    codecOf(TestAllTypesProto2Schema, ConformanceProcedures.proto2),
  ],
  [
    'protobuf_test_messages.editions.TestAllTypesEdition2023',
    codecOf(TestAllTypesEdition2023Schema, ConformanceProcedures.edition2023),
  ],
  [
    'protobuf_test_messages.editions.proto2.TestAllTypesProto2',
    codecOf(EditionsProto2Schema, ConformanceProcedures.editionsProto2),
  ],
  [
    'protobuf_test_messages.editions.proto3.TestAllTypesProto3',
    codecOf(EditionsProto3Schema, ConformanceProcedures.editionsProto3),
  ],
  ['bead.codecs.v1.Probe', codecOf(ProbeSchema, ConformanceProcedures.probe)],
]);

// the messages an `Any` of the suite's may name
const REGISTRY = typeRegistryOf(
  [...CODECS.values()].map((codec) => {
    return codec.schema;
  })
);

const reasonOf = (error: unknown): string => {
  return error instanceof Error ? error.message : 'not its message';
};

// a payload's message: a JSON one read by Bead's mapping, then its bytes read as its codec reads a
// payload (transcoding 5.2, its last step), a binary one by its codec alone
const messageOf = (codec: ICodec, request: ConformanceRequest): Message => {
  if (request.payload.case === 'jsonPayload') {
    const read = readProtoJson(codec.schema, {
      bytes: new TextEncoder().encode(request.payload.value),
      registry: REGISTRY,
    });

    return codec.decode(toBinary(codec.schema, read));
  }

  return codec.decode(
    request.payload.case === 'protobufPayload' ? request.payload.value : new Uint8Array()
  );
};

const answerOf = (request: ConformanceRequest): Response => {
  // the runner asks first which tests a testee expects to fail: none of its own, the failure list
  // the tool gives the runner names them
  if (request.messageType === 'conformance.FailureSet') {
    return { result: { case: 'protobufPayload', value: new Uint8Array() } };
  }

  // ! Bead's proto carries the binary form and protobuf's JSON mapping alone; a skip never hides
  // a binary or a JSON test of a form Bead reads
  if (
    request.payload.case === 'jspbPayload' ||
    request.payload.case === 'textPayload' ||
    request.requestedOutputFormat === WireFormat.JSPB ||
    request.requestedOutputFormat === WireFormat.TEXT_FORMAT
  ) {
    return {
      result: {
        case: 'skipped',
        value: "Bead's proto carries the binary form and protobuf's JSON mapping alone",
      },
    };
  }

  if (request.testCategory === TestCategory.JSON_IGNORE_UNKNOWN_PARSING_TEST) {
    return {
      result: {
        case: 'skipped',
        value: "Bead's mapping refuses an unknown member, and takes no option to ignore one",
      },
    };
  }

  if (request.messageType.startsWith('protobuf_test_messages.edition_unstable.')) {
    return {
      result: {
        case: 'skipped',
        value: 'an unstable edition, which no stock generator compiles',
      },
    };
  }

  const codec = CODECS.get(request.messageType);

  // ! a message gone fails its tests, rather than skipping them
  if (codec === undefined) {
    return {
      result: { case: 'runtimeError', value: `no procedure binds ${request.messageType}` },
    };
  }

  let message: Message;

  try {
    message = messageOf(codec, request);
  } catch (error) {
    return { result: { case: 'parseError', value: reasonOf(error) } };
  }

  if (request.requestedOutputFormat === WireFormat.JSON) {
    try {
      return {
        result: {
          case: 'jsonPayload',
          value: writeProtoJson(codec.schema, { message, registry: REGISTRY }),
        },
      };
    } catch (error) {
      if (error instanceof JsonFormError) {
        return { result: { case: 'serializeError', value: error.message } };
      }

      throw error;
    }
  }

  return { result: { case: 'protobufPayload', value: codec.encode(message) } };
};

let pending = Buffer.alloc(0);

for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk as Buffer]);

  while (pending.length >= HEAD && pending.length >= HEAD + pending.readUInt32LE(0)) {
    const end = HEAD + pending.readUInt32LE(0);
    const request = ConformanceProcedures.conformance.request.decode(pending.subarray(HEAD, end));
    const response = ConformanceProcedures.conformance.result.encode(answerOf(request));
    const head = Buffer.alloc(HEAD);

    pending = pending.subarray(end);
    head.writeUInt32LE(response.length, 0);
    process.stdout.write(Buffer.concat([head, response]));
  }
}
