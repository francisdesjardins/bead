import { expect, test } from '@playwright/test';
import { TRAFFIC } from '../../__tests__/traffic';
import { LOG_FORMAT, LOG_VERSION, logOf, readLog } from '../log';

// helpers

const SOURCES = [{ id: 1, protocol: 1, side: 'client' }];

// definition

test.describe('logOf and readLog', () => {
  test('save the records, their clients and what was let go, and read them back as they were', () => {
    const log = logOf(
      { dropped: 3, records: [...TRAFFIC], sources: SOURCES },
      { savedAt: new Date('2026-10-13T12:00:00.000Z') }
    );

    expect(log).toMatchObject({
      dropped: 3,
      format: LOG_FORMAT,
      protocols: [1],
      savedAt: '2026-10-13T12:00:00.000Z',
      version: LOG_VERSION,
    });
    expect(readLog(JSON.stringify(log))).toEqual(JSON.parse(JSON.stringify(log)));
  });

  test('refuse what they cannot read, saying why: not JSON, another format, another version, another protocol, records that do not read', () => {
    const log = logOf({ dropped: 0, records: [], sources: SOURCES }, { savedAt: new Date(0) });

    expect(() => {
      return readLog('{');
    }).toThrow('it is not JSON');
    expect(() => {
      return readLog(JSON.stringify({ ...log, format: 'har' }));
    }).toThrow(`it is no ${LOG_FORMAT}`);
    expect(() => {
      return readLog(JSON.stringify({ ...log, version: 3 }));
    }).toThrow('it is version 3');
    expect(() => {
      return readLog(JSON.stringify({ ...log, protocols: [2] }));
    }).toThrow("its records are of the hook's protocol 2");
    expect(() => {
      return readLog(JSON.stringify({ ...log, records: [{ kind: 'other' }] }));
    }).toThrow('its records do not read');
  });
});

test('writes version 1 for calls alone and version 2 for participant records, keeping gaps and skipping unknown kinds', () => {
  const callLog = logOf(
    { dropped: 0, records: [...TRAFFIC], sources: SOURCES },
    { savedAt: new Date(0) }
  );
  expect(callLog.version).toBe(1);
  const record = {
    kind: 'participant' as const,
    event: 'link' as const,
    at: 100,
    source: 2,
    state: 'down' as const,
    ended: [1],
  };
  const log = logOf(
    {
      dropped: 4,
      droppedParticipants: 7,
      records: [...TRAFFIC, record],
      sources: [...SOURCES, { id: 2, protocol: 1, side: 'participant' }],
    },
    { savedAt: new Date(0) }
  );
  expect(log.version).toBe(2);
  expect(readLog(JSON.stringify(log))).toEqual(JSON.parse(JSON.stringify(log)));
  const forward = readLog(
    JSON.stringify({ ...log, records: [...log.records, { kind: 'future', source: 2 }] })
  );
  expect(forward.skipped).toBe(1);
  expect(forward.droppedParticipants).toBe(7);
  expect(forward.records).toEqual(log.records);
  expect(readLog(JSON.stringify(logOf(forward, { savedAt: new Date(0) }))).skipped).toBe(1);
});

test('drops private participant fields on import as well as on the source mapping', () => {
  const log = logOf(
    {
      dropped: 0,
      sources: [],
      records: [
        {
          kind: 'participant',
          source: 1,
          at: 1,
          event: 'parcel',
          parcelKind: 'DATA',
          hasCredential: true,
        },
      ],
    },
    { savedAt: new Date(0) }
  );
  const imported = readLog(
    JSON.stringify({
      ...log,
      records: [
        {
          ...log.records[0],
          acceptor: 'cafe1234beef5678',
          credential: 'trace-secret',
          carried: [1, 2],
        },
      ],
    })
  );
  const exported = JSON.stringify(logOf(imported, { savedAt: new Date(0) }));
  expect(exported).not.toContain('cafe1234beef5678');
  expect(exported).not.toContain('trace-secret');
  expect(exported).not.toContain('"carried"');
  expect(imported.records[0]).toMatchObject({
    kind: 'participant',
    parcelKind: 'DATA',
    hasCredential: true,
  });
});
