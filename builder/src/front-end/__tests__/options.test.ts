import { expect, test } from '@playwright/test';

import { compile } from '../../compile.ts';
import { readSet } from '../input.ts';
import { admissionOf, fileOptionsOf, procedureOptionsOf, serviceOptionsOf } from '../options.ts';
import { FIXTURES, INTEROP_PROTO } from './derive.ts';

test("reads the interop's options: its file's admission, its service, each procedure's kind and admission", () => {
  const input = readSet(compile([FIXTURES]), { roots: [FIXTURES], files: [INTEROP_PROTO] });
  const file = input.files[0]?.desc;
  const service = file?.services[0];

  expect(file === undefined ? undefined : fileOptionsOf(file)?.admission?.rule.case).toBe('none');
  expect(service === undefined ? undefined : serviceOptionsOf(service)?.id).toBe(1);

  const read = (service?.methods ?? []).map((method) => {
    const options = procedureOptionsOf(method);
    const admission =
      options?.admission === undefined ? '' : `/${JSON.stringify(admissionOf(options.admission))}`;

    return `${String(options?.id)}:${options?.procedureKind.case ?? 'request'}${admission}`;
  });

  expect(read).toEqual([
    '1:request',
    '2:request',
    '3:request',
    '4:request',
    '5:request/{"hook":"nobody"}',
    '6:request',
    '7:request',
    '8:request',
    '9:command',
    '10:notifies',
    '11:request',
    '12:request',
    '13:request/"session"',
    '14:request/"session"',
    '15:request',
    '16:request',
    '17:request',
    '18:request',
  ]);
});
