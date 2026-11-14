// ── Fuzz target: the JSON form ────────────────────────────────────────────────

// protobuf's JSON read by Bead's mapping (transcoding 5.2), over `spec/transcoding.proto`'s
// `Everything`, the input's first byte even, or its `Edges`, odd; the rest is read as a body: a
// refusal, a `JsonFormError`, passes. What reads is written; what was written reads; and it writes
// again to the same text, byte for byte. No message is compared: a map's entries read in the text's
// order are written in 17.7.6's, and a `-0` is written `0` or left out (5.6). Any other throw, a
// write's refusal of what read, or a second text that differs is a finding. The C# side's
// `JsonFormTarget` and the Rust side's `json-form` are its twins.

// dependencies

import type { DescMessage } from '@bufbuild/protobuf';
import { createJsonForm, JsonFormError } from '../../src/transcoding/json-form';
import {
  EdgesSchema,
  EverythingSchema,
} from '../../src/transcoding/__tests__/generated/transcoding_pb';
import { hexadecimalOf, isRefused } from './refusal';

// constants

// the messages the first byte picks, by its parity
const MESSAGES: readonly DescMessage[] = [EverythingSchema, EdgesSchema];

const FORM = createJsonForm(MESSAGES);

const ENCODER = new TextEncoder();

// definition

export const fuzz = (data: Uint8Array): void => {
  const [pick] = data;

  if (pick === undefined) {
    return;
  }

  const schema = MESSAGES[pick % 2] ?? EverythingSchema;
  let message: ReturnType<typeof FORM.read> | undefined;

  isRefused(JsonFormError, () => {
    message = FORM.read(schema, data.subarray(1));
  });

  if (message === undefined) {
    return;
  }

  // * from here every throw is a finding: the form writes what it read, and reads what it wrote
  const written = FORM.write(schema, message);
  const again = FORM.write(schema, FORM.read(schema, ENCODER.encode(written)));

  if (again !== written) {
    throw new Error(`a JSON text is written again otherwise: ${hexadecimalOf(data)}`);
  }
};
