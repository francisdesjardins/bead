// ── A log, saved and read back ────────────────────────────────────────────────

// What Export writes and Import reads: the records the panel holds, in the order it took them, the
// clients they came from, and the records let go, in a JSON document that names its format, its
// version and the hook's protocol its records were made by, so a reader refuses one it cannot read
// rather than misreading it.

// dependencies

import type { ActivityRecord, ISourceRecord } from '../messages';
import { PROTOCOLS } from '../messages';
import { participantRecordOf } from '../records';

// interfaces

/** A log, as Export writes it. */
export interface ILog {
  /** The records let go before the panel took them, as the hook counted them. */
  dropped: number;
  /** Participant losses at the hook, during pause and past the panel’s retention. */
  droppedParticipants: number;
  /** Record kinds skipped by a reader of version 2. */
  skipped: number;
  format: typeof LOG_FORMAT;
  /** The hook's protocols its records were made by. */
  protocols: number[];
  records: ActivityRecord[];
  /** When it was saved, as RFC 3339 writes a time. */
  savedAt: string;
  sources: ISourceRecord[];
  version: 1 | 2;
}

// constants

/** What names a log among the JSON documents a person may pick. */
export const LOG_FORMAT = 'bead-devtools-log';

/** The version of the log's shape, which a change to it moves. */
export const LOG_VERSION = 1;

// helpers

const isRecord = (value: unknown): value is ActivityRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const { kind, source } = value as Partial<ActivityRecord>;

  return (
    (kind === 'call' || kind === 'envelope' || kind === 'participant') && typeof source === 'number'
  );
};

// definition

/** A log of `records`, from `sources`, saved `savedAt`. */
export const logOf = (
  {
    dropped,
    droppedParticipants = 0,
    skipped = 0,
    records,
    sources,
  }: {
    dropped: number;
    droppedParticipants?: number;
    skipped?: number;
    records: ActivityRecord[];
    sources: ISourceRecord[];
  },
  { savedAt }: { savedAt: Date }
): ILog => {
  return {
    dropped,
    droppedParticipants,
    skipped,
    format: LOG_FORMAT,
    protocols: [...PROTOCOLS],
    records,
    savedAt: savedAt.toISOString(),
    sources,
    version: records.some((record) => {
      return record.kind === 'participant';
    })
      ? 2
      : 1,
  };
};

/** A log read back from its text; one it cannot read throws, saying why. */
export const readLog = (text: string): ILog => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('it is not JSON');
  }

  const log = (typeof value === 'object' && value !== null ? value : {}) as Partial<ILog>;

  if (log.format !== LOG_FORMAT) {
    throw new Error(`it is no ${LOG_FORMAT}`);
  }

  if (log.version !== 1 && log.version !== 2) {
    throw new Error(`it is version ${String(log.version)}, and this extension reads 1 and 2`);
  }

  const unknown = (log.protocols ?? []).filter((protocol) => {
    return !PROTOCOLS.includes(protocol);
  });

  if (unknown.length > 0) {
    throw new Error(
      `its records are of the hook's protocol ${unknown.join(', ')}, which this extension does not read`
    );
  }

  if (!Array.isArray(log.records) || !Array.isArray(log.sources)) {
    throw new Error('its records do not read');
  }
  const records: ActivityRecord[] = [];
  let skipped = log.skipped ?? 0;
  const rawRecords: unknown[] = log.records;
  for (const record of rawRecords) {
    if (isRecord(record)) {
      if (log.version === 1 && record.kind === 'participant') {
        throw new Error('its records do not read');
      }
      if (record.kind === 'participant') {
        const mapped = participantRecordOf({ at: record.at, source: record.source }, record);
        mapped.parcelKind = record.parcelKind;
        records.push(mapped);
      } else {
        records.push(record);
      }
    } else if (
      log.version === 2 &&
      typeof record === 'object' &&
      record !== null &&
      typeof (record as { kind?: unknown }).kind === 'string' &&
      !['call', 'envelope', 'participant'].includes((record as { kind: string }).kind)
    ) {
      skipped += 1;
    } else {
      throw new Error('its records do not read');
    }
  }

  return {
    dropped: typeof log.dropped === 'number' ? log.dropped : 0,
    droppedParticipants: typeof log.droppedParticipants === 'number' ? log.droppedParticipants : 0,
    skipped,
    format: LOG_FORMAT,
    protocols: log.protocols ?? [...PROTOCOLS],
    records,
    savedAt: typeof log.savedAt === 'string' ? log.savedAt : '',
    sources: log.sources,
    version: log.version,
  };
};
