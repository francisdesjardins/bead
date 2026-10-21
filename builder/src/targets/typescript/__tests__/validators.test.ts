import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type DescMessage, fromBinary } from '@bufbuild/protobuf';
import { expect, test } from '@playwright/test';

import { checkRoots } from '../../../check.ts';
import { generateMessages } from '../../../messages.ts';
import { Messages } from '../../target.ts';
import { typescriptTarget } from '../typescript.ts';

const SPEC = fileURLToPath(new URL('../../../../../spec/', import.meta.url));
const VALIDATIONS = new URL('../../../../../spec/validations.json', import.meta.url);
const RUNTIME = fileURLToPath(new URL('../../../../test/runtime/', import.meta.url));

interface IRun {
  readonly bytes: string;
  readonly times: number;
}

interface IVerdict {
  readonly name: string;
  readonly message: string;
  readonly payload?: string;
  readonly runs?: readonly IRun[];
  readonly maximumBytes?: number;
  readonly failFast?: true;
  readonly violations: readonly unknown[];
  readonly more?: number;
  readonly stopped?: true;
}

interface IJudged {
  readonly violations: readonly Record<string, unknown>[];
  readonly more: number;
  readonly stopped: boolean;
}

type Validate = (request: unknown, options?: object) => IJudged;

const bytesOf = (hex: string): Uint8Array => {
  return Uint8Array.from(
    hex
      .split(' ')
      .filter((part) => {
        return part !== '';
      })
      .map((part) => {
        return Number.parseInt(part, 16);
      })
  );
};

// a verdict's payload: its bytes, or its runs end to end
const payloadOf = (verdict: IVerdict): Uint8Array => {
  if (verdict.payload !== undefined) {
    return bytesOf(verdict.payload);
  }

  const parts = (verdict.runs ?? []).flatMap((run) => {
    return Array.from({ length: run.times }, () => {
      return bytesOf(run.bytes);
    });
  });
  const bytes = new Uint8Array(
    parts.reduce((total, part) => {
      return total + part.length;
    }, 0)
  );
  let at = 0;

  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
};

// the validators beadc writes for spec/validations.proto, with its messages, in the running test's
// output folder, over test/runtime/'s stand-ins for the runtime, loaded
const generatedOf = async (): Promise<{
  readonly bead: Record<string, Record<string, { validate?: Validate }>>;
  readonly messages: Record<string, DescMessage>;
}> => {
  const checked = checkRoots([SPEC], { files: ['validations.proto'] });
  const { blueprint, set } = checked;

  if (blueprint === undefined || set === undefined) {
    throw new Error(`spec/validations.proto: ${JSON.stringify(checked.diagnostics)}`);
  }

  const folder = test.info().outputPath('generated');
  const runtimeOf = (module: string): string => {
    return relative(folder, join(RUNTIME, module)).split(sep).join('/');
  };
  const files = [
    ...generateMessages(set, { blueprint, importExtension: 'ts' }),
    ...typescriptTarget.generate(
      { blueprint, set, sources: { blueprint: 'spec/validations.proto' } },
      {
        importExtension: 'ts',
        runtime: runtimeOf('service-stub'),
        protoRuntime: runtimeOf('proto-stub'),
        messages: Messages.GENERATE,
      }
    ),
  ];

  for (const file of files) {
    mkdirSync(dirname(join(folder, file.name)), { recursive: true });
    writeFileSync(join(folder, file.name), file.content);
  }

  return {
    bead: (await import(pathToFileURL(join(folder, 'validations_bead.ts')).href)) as Record<
      string,
      Record<string, { validate?: Validate }>
    >,
    messages: (await import(pathToFileURL(join(folder, 'validations_pb.ts')).href)) as Record<
      string,
      DescMessage
    >,
  };
};

test('plays the verdicts of spec/validations.json through the validators beadc writes for spec/validations.proto', async () => {
  const { bead, messages } = await generatedOf();
  const { verdicts } = JSON.parse(readFileSync(VALIDATIONS, 'utf8')) as {
    readonly verdicts: readonly IVerdict[];
  };

  expect(verdicts.length).toBeGreaterThan(0);

  for (const verdict of verdicts) {
    const name = verdict.message.split('.').at(-1) ?? '';
    const schema = messages[`${name}Schema`];
    const validate = bead['ValidationsProcedures']?.[`judge${name}`]?.validate;

    if (schema === undefined || validate === undefined) {
      throw new Error(`${verdict.name}: no validator of ${verdict.message}`);
    }

    const judged = validate(fromBinary(schema, payloadOf(verdict)), {
      failFast: verdict.failFast === true,
      maximumBytes: verdict.maximumBytes ?? 2_147_483_647,
    });

    expect(
      {
        violations: judged.violations.map(({ value: _value, ...violation }) => {
          return violation;
        }),
        more: judged.more,
        stopped: judged.stopped,
      },
      verdict.name
    ).toEqual({
      violations: verdict.violations,
      more: verdict.more ?? 0,
      stopped: verdict.stopped === true,
    });
  }
});

test('keeps the value a violation broke on the side that judged, and builds no violation of a request that breaks nothing', async () => {
  const { bead, messages } = await generatedOf();
  const validate = bead['ValidationsProcedures']?.['judgeNumbers']?.validate;
  const schema = messages['NumbersSchema'];

  if (validate === undefined || schema === undefined) {
    throw new Error('no validator of Numbers');
  }

  // at_most_ten, 11; and nothing else set
  expect(validate(fromBinary(schema, bytesOf('08 0B'))).violations).toEqual([
    {
      bounds: { lte: 10 },
      fieldPath: 'at_most_ten',
      message: 'must be less than or equal to 10',
      ruleId: 'int32.lte',
      value: 11,
    },
  ]);
  expect(validate({ atMostTen: 10 })).toEqual({ violations: [], more: 0, stopped: false });
});
