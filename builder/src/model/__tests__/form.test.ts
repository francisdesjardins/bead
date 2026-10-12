import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { formDifferencesOf, formOf, projectionOf, sortedOf } from '../form.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

const interopText = (): string => {
  return readFileSync(INTEROP, 'utf8');
};

test("writes RFC 8785's members and escapes, two spaces and a final line feed", () => {
  const value = {
    z: 1,
    a: { y: [], b: {} },
    text: `\u0000\u0007\b\t\n\f\r\u001f"\\/\u007f\u0080\u00e9\u2028\u2029\uFEFF\uFFFF\u{1F600}`,
  };

  expect(formOf(value)).toBe(
    [
      '{',
      '  "a": {',
      '    "b": {},',
      '    "y": []',
      '  },',
      `  "text": "\\u0000\\u0007\\b\\t\\n\\f\\r\\u001f\\"\\\\/\u007f\u0080\u00e9\u2028\u2029\uFEFF\uFFFF\u{1F600}",`,
      '  "z": 1',
      '}',
      '',
    ].join('\n')
  );
  expect(formOf(JSON.parse(interopText()))).toBe(interopText());
});

test('sorts every array as check.py sorts it, names and ranges included', () => {
  const blueprint = {
    requires: ['b-feature', 'a-feature'],
    proto: {
      files: [{ path: 'z.proto' }, { path: 'a.proto' }],
      messages: [{ fullName: 'z.M' }, { fullName: 'a.M' }],
    },
    reservedServices: {
      ids: [
        { first: 9, last: 9 },
        { first: 2, last: 4 },
        { first: 2, last: 3 },
      ],
      names: ['Zed', 'Alpha'],
    },
    services: [
      {
        serviceId: 2,
        failures: [
          { code: 8, failureName: 'LATE' },
          { code: 7, failureName: 'EARLY' },
        ],
        reserved: {
          procedureIds: [
            { first: 5, last: 6 },
            { first: 1, last: 1 },
          ],
          procedureNames: ['zeta', 'alpha'],
          failureCodes: [
            { first: 30, last: 30 },
            { first: 20, last: 20 },
          ],
        },
        procedures: [
          { procedureId: 3, failures: ['UNKNOWN', 'LATE', 'EARLY'] },
          { procedureId: 1, failures: [] },
        ],
      },
      {
        serviceId: 1,
        failures: [],
        reserved: { procedureIds: [], procedureNames: [], failureCodes: [] },
        procedures: [],
      },
    ],
  };
  const sorted = sortedOf(blueprint);

  expect(sorted.requires).toEqual(['a-feature', 'b-feature']);
  expect(sorted.proto.files).toEqual([{ path: 'a.proto' }, { path: 'z.proto' }]);
  expect(sorted.proto.messages).toEqual([{ fullName: 'a.M' }, { fullName: 'z.M' }]);
  expect(sorted.reservedServices.ids).toEqual([
    { first: 2, last: 3 },
    { first: 2, last: 4 },
    { first: 9, last: 9 },
  ]);
  expect(sorted.reservedServices.names).toEqual(['Alpha', 'Zed']);
  expect(
    sorted.services.map((service) => {
      return service.serviceId;
    })
  ).toEqual([1, 2]);

  const [, service] = sorted.services;

  expect(service?.failures).toEqual([
    { code: 7, failureName: 'EARLY' },
    { code: 8, failureName: 'LATE' },
  ]);
  expect(service?.reserved.procedureIds).toEqual([
    { first: 1, last: 1 },
    { first: 5, last: 6 },
  ]);
  expect(service?.reserved.procedureNames).toEqual(['alpha', 'zeta']);
  expect(service?.reserved.failureCodes).toEqual([
    { first: 20, last: 20 },
    { first: 30, last: 30 },
  ]);
  expect(
    service?.procedures.map((procedure) => {
      return procedure.procedureId;
    })
  ).toEqual([1, 3]);
  // in their codes' order, a name its catalogue lacks last
  expect(service?.procedures[1]?.failures).toEqual(['EARLY', 'LATE', 'UNKNOWN']);
  // the value given is left as it was
  expect(blueprint.requires).toEqual(['b-feature', 'a-feature']);
});

test('names the first line off, an array out of its order, a missing newline and a byte order mark', () => {
  const text = interopText();
  const value = JSON.parse(text) as { requires: string[]; services: { procedures: unknown[] }[] };

  expect(formDifferencesOf(text, value)).toEqual([]);
  expect(formDifferencesOf(text.replace('"requires": []', '"requires":  []'), value)).toEqual([
    { line: 3, message: 'line 3 is off its form' },
  ]);
  expect(formDifferencesOf(text.replaceAll('\n', '\r\n'), value)).toEqual([
    { line: 1, message: 'line 1 is off its form, a carriage return its form never writes' },
  ]);
  expect(formDifferencesOf(text.slice(0, -1), value)).toEqual([
    { line: 299, message: 'its last line ends with no line feed' },
  ]);
  expect(formDifferencesOf(`\uFEFF${text}`, value)).toEqual([
    { line: 1, message: 'it opens with a byte order mark, which its form never writes' },
  ]);

  const procedures = value.services[0]?.procedures ?? [];

  procedures.reverse();
  expect(formDifferencesOf(text, value)).toEqual([
    { pointer: '/services/0/procedures', message: 'out of its order' },
  ]);
});

test('its projection leaves out what a front end read', () => {
  const blueprint = {
    proto: { files: [], messages: [] },
    services: [{ proto: { file: 'a.proto' }, serviceId: 1 }],
  };

  expect(projectionOf(blueprint)).toEqual({ services: [{ serviceId: 1 }] });
  expect(blueprint.proto).toBeDefined();
});
