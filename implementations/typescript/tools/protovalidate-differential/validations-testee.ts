// ── Protovalidate differential testee ─────────────────────────────────────────

// The TypeScript side's testee of the protovalidate differential (decision 0035), as
// tools/protovalidate-differential.mjs drives one: on the standard input, a case a line,
// `{"message":"<full name>","payload":"<base64>"}`; on the standard output, a line for each, the
// violations the validator beadc generates for that message gives, `failFast` off and no bound, or
// `{"refused":true}` where its codec does not read the payload. `generated/` is what that tool
// generates at run time, never committed.

// dependencies

import { createInterface } from 'node:readline';

import type { Validator } from '../../src/proto/proto.ts';
import type { IViolation } from '../../src/router/shared/violations.ts';
import { ValidationsProcedures } from './generated/validations_bead.ts';

// interfaces

/** A procedure of the generated service: its request's codec, and its validator. */
interface IJudging {
  readonly request: { readonly decode: (bytes: Uint8Array) => unknown };
  readonly validate?: Validator | undefined;
}

/** A case, as the tool writes it. */
interface ICase {
  readonly message: string;
  readonly payload: string;
}

// constants

// each message's procedure, by its full name: `bead.validations.v1.<Name>` bound by `judge<Name>`
const JUDGINGS: ReadonlyMap<string, IJudging> = new Map(
  Object.entries(ValidationsProcedures as Readonly<Record<string, IJudging>>).map(
    ([name, judging]) => {
      return [`bead.validations.v1.${name.slice('judge'.length)}`, judging];
    }
  )
);

// helpers

/** A violation as the wire carries it: its members, the value it broke left on this side. */
const sentOf = ({ value: _value, ...violation }: IViolation): Omit<IViolation, 'value'> => {
  return violation;
};

const answerOf = ({ message, payload }: ICase): string => {
  const judging = JUDGINGS.get(message);

  // ! a message gone fails the run, rather than passing as refused
  if (judging?.validate === undefined) {
    throw new Error(`no procedure judges ${message}`);
  }

  let read: unknown;

  try {
    read = judging.request.decode(Uint8Array.from(Buffer.from(payload, 'base64')));
  } catch {
    return JSON.stringify({ refused: true });
  }

  return JSON.stringify({ violations: judging.validate(read).violations.map(sentOf) });
};

// definition

for await (const line of createInterface({ input: process.stdin })) {
  if (line !== '') {
    process.stdout.write(`${answerOf(JSON.parse(line) as ICase)}\n`);
  }
}
