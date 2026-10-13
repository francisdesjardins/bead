// ── Protobuf conformance testee ───────────────────────────────────────────────

// The TypeScript side's testee of protobuf's conformance suite (decision 0028), as the suite's
// runner drives one: on the standard input, each ConformanceRequest after its length, a 32-bit
// little-endian integer; on the standard output, each ConformanceResponse alike, until the input
// ends. Each message is read and written back through the codec beadc generates for the procedure
// that binds it, found by the message's full name, so the check of its records runs before
// protobuf-es reads it, as it does in any project that binds proto. `generated/` is what
// tools/protobuf-conformance.mjs generates at run time, never committed.

// dependencies

import type { MessageInitShape } from '@bufbuild/protobuf';

import type {
  ConformanceRequest,
  ConformanceResponseSchema,
} from './generated/conformance/conformance_pb.ts';
import { WireFormat } from './generated/conformance/conformance_pb.ts';
import { ConformanceProcedures } from './generated/service_bead.ts';

// interfaces

/** A procedure whose request and result are one message: read by the one, written by the other. */
interface IRoundTrip<Value> {
  readonly request: { readonly decode: (bytes: Uint8Array) => Value };
  readonly result: { readonly encode: (value: Value) => Uint8Array };
}

// types

/** A message's bytes read now, and what writes it back. */
type ReadBack = (bytes: Uint8Array) => () => Uint8Array;

type Response = MessageInitShape<typeof ConformanceResponseSchema>;

// constants

const HEAD = 4;

// definition

const roundTripOf = <Value>(procedure: IRoundTrip<Value>): ReadBack => {
  return (bytes) => {
    const message = procedure.request.decode(bytes);

    return () => {
      return procedure.result.encode(message);
    };
  };
};

// each message the suite sends, by its full name
const ROUND_TRIPS: ReadonlyMap<string, ReadBack> = new Map([
  ['protobuf_test_messages.proto3.TestAllTypesProto3', roundTripOf(ConformanceProcedures.proto3)],
  ['protobuf_test_messages.proto2.TestAllTypesProto2', roundTripOf(ConformanceProcedures.proto2)],
  [
    'protobuf_test_messages.editions.TestAllTypesEdition2023',
    roundTripOf(ConformanceProcedures.edition2023),
  ],
  [
    'protobuf_test_messages.editions.proto2.TestAllTypesProto2',
    roundTripOf(ConformanceProcedures.editionsProto2),
  ],
  [
    'protobuf_test_messages.editions.proto3.TestAllTypesProto3',
    roundTripOf(ConformanceProcedures.editionsProto3),
  ],
  ['bead.codecs.v1.Probe', roundTripOf(ConformanceProcedures.probe)],
]);

const answerOf = (request: ConformanceRequest): Response => {
  // the runner asks first which tests a testee expects to fail: none of its own, the failure list
  // the tool gives the runner names them
  if (request.messageType === 'conformance.FailureSet') {
    return { result: { case: 'protobufPayload', value: new Uint8Array() } };
  }

  // ! Bead's proto carries the binary form alone; a skip never hides a binary test
  if (
    request.payload.case !== 'protobufPayload' ||
    request.requestedOutputFormat !== WireFormat.PROTOBUF
  ) {
    return { result: { case: 'skipped', value: "Bead's proto carries the binary form alone" } };
  }

  if (request.messageType.startsWith('protobuf_test_messages.edition_unstable.')) {
    return {
      result: {
        case: 'skipped',
        value: 'an unstable edition, which no stock generator compiles',
      },
    };
  }

  const roundTrip = ROUND_TRIPS.get(request.messageType);

  // ! a message gone fails its tests, rather than skipping them
  if (roundTrip === undefined) {
    return {
      result: { case: 'runtimeError', value: `no procedure binds ${request.messageType}` },
    };
  }

  let writeBack: () => Uint8Array;

  try {
    writeBack = roundTrip(request.payload.value);
  } catch (error) {
    return {
      result: {
        case: 'parseError',
        value: error instanceof Error ? error.message : 'not its message',
      },
    };
  }

  return { result: { case: 'protobufPayload', value: writeBack() } };
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
