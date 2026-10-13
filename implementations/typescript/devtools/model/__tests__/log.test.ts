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
      return readLog(JSON.stringify({ ...log, version: 2 }));
    }).toThrow('it is version 2');
    expect(() => {
      return readLog(JSON.stringify({ ...log, protocols: [2] }));
    }).toThrow("its records are of the hook's protocol 2");
    expect(() => {
      return readLog(JSON.stringify({ ...log, records: [{ kind: 'other' }] }));
    }).toThrow('its records do not read');
  });
});
