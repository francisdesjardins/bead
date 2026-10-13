// ── The panel's words ─────────────────────────────────────────────────────────

// What the panel writes of a number, a time, a byte count and an envelope, the package's names for
// its kinds, codes and schemes read once: a header in words rather than its fields, so "credit up to
// 2.5 MiB" reads where `creditEnd 2621440` would.

// dependencies

import {
  CredentialScheme,
  FailureScope,
  ProtocolCode,
} from '../../src/router/client/router-client';
import { EnvelopeKind } from '../../src/router/shared/constants';
import type { IErrorRecord } from '../messages';

// interfaces

/** An envelope's header, as a record carries it: each field a number, a string or a boolean. */
export type PlainHeader = Readonly<Record<string, boolean | number | string>>;

// constants

const namesOf = (values: Record<string, number>): ReadonlyMap<number, string> => {
  return new Map(
    Object.entries(values).map(([name, value]) => {
      return [value, name];
    })
  );
};

/** The protocol's codes, by their number. */
export const CODE_NAMES = namesOf(ProtocolCode);

/** The envelope kinds, by their number. */
export const KIND_NAMES = namesOf(EnvelopeKind);

/** The credential schemes, by their number. */
export const SCHEME_NAMES = namesOf(CredentialScheme);

const KIBIBYTE = 1_024;
const MEBIBYTE = KIBIBYTE * 1_024;

const numbers = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 3 });
const shortNumbers = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 1 });
const seconds = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 2 });

// helpers

const kindOf = (header: PlainHeader): number => {
  return Number(header['kind']);
};

// definition

/** A number, grouped, to three decimals at most. */
export const numberOf = (value: number): string => {
  return numbers.format(value);
};

/** A count of bytes, in bytes, KiB or MiB, a count that would read as 1,024 KiB read in MiB. */
export const bytesOf = (count: number): string => {
  if (Math.round((count / KIBIBYTE) * 10) / 10 >= KIBIBYTE) {
    return `${shortNumbers.format(count / MEBIBYTE)} MiB`;
  }

  if (count >= KIBIBYTE) {
    return `${shortNumbers.format(count / KIBIBYTE)} KiB`;
  }

  return `${numbers.format(count)} ${count === 1 ? 'byte' : 'bytes'}`;
};

/** A span of milliseconds: in milliseconds below a second, in seconds from it. */
export const spanOf = (milliseconds: number): string => {
  return milliseconds >= 1_000
    ? `${seconds.format(milliseconds / 1_000)} s`
    : `${numbers.format(Math.round(milliseconds * 10) / 10)} ms`;
};

/** A time of day, to the millisecond, in the panel's locale's 24 hours. */
export const clockOf = (milliseconds: number): string => {
  const date = new Date(milliseconds);
  const parts = [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => {
    return String(part).padStart(2, '0');
  });

  return `${parts.join(':')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};

/** An envelope kind's name, or its number in hexadecimal for one the package does not name. */
export const kindNameOf = (header: PlainHeader): string => {
  const kind = kindOf(header);

  return KIND_NAMES.get(kind) ?? `0x${kind.toString(16)}`;
};

/** A credential scheme's name, or its number. */
export const schemeNameOf = (scheme: number): string => {
  return SCHEME_NAMES.get(scheme) ?? `scheme ${String(scheme)}`;
};

/** A protocol code's name, or its number. */
export const codeNameOf = (code: number): string => {
  return CODE_NAMES.get(code) ?? `code ${String(code)}`;
};

/**
 * What a header says, past its kind and its call, in words: what a request opens and presents, what
 * an answer announces, how far a credit reaches, where a chunk stands.
 */
export const headerWordsOf = (header: PlainHeader): string[] => {
  const kind = kindOf(header);
  const words: string[] = [];
  const total = header['total'];
  const scheme = header['credentialScheme'];

  if (kind === EnvelopeKind.REQUEST) {
    if (header['opensSubscription'] === true) {
      words.push(header['paced'] === true ? 'paced subscription' : 'subscription');
    }

    if (typeof header['destinationId'] === 'number') {
      words.push(`to destination ${String(header['destinationId'])}`);
    }
  }

  if (typeof total === 'number') {
    words.push(`opens a transfer of ${bytesOf(total)}`);
  }

  if (typeof scheme === 'number') {
    words.push(
      kind === EnvelopeKind.REQUEST
        ? `credential ${schemeNameOf(scheme)}`
        : scheme === CredentialScheme.NONE
          ? 'announces the session ended, NONE'
          : `announces a session, ${schemeNameOf(scheme)}`
    );
  }

  if (kind === EnvelopeKind.CREDIT && typeof header['creditEnd'] === 'number') {
    const end = header['creditEnd'];

    words.push(
      header['paced'] === true
        ? `up to ${numberOf(end)} ${end === 1 ? 'notification' : 'notifications'}`
        : `up to ${bytesOf(end)}`
    );
  }

  if (kind === EnvelopeKind.CHUNK) {
    words.push(
      `at ${bytesOf(Number(header['offset'] ?? 0))}`,
      header['isLast'] === true ? 'last' : 'more'
    );
  }

  return words;
};

/** An envelope's line: its kind, then what its header says in words. */
export const envelopeLineOf = (header: PlainHeader): string => {
  return [kindNameOf(header), ...headerWordsOf(header)].join(' · ');
};

/** The name of an error a step told, as a person reads it, its code's where a failure gives one. */
export const failureWordsOf = (error: IErrorRecord): string => {
  if (error.code === undefined) {
    return error.name;
  }

  const relays =
    error.relays === undefined || error.relays === 0
      ? ''
      : `, beyond ${String(error.relays)} ${error.relays === 1 ? 'relay' : 'relays'}`;

  return error.scope === FailureScope.APPLICATION
    ? `procedure code ${String(error.code)}${relays}`
    : `${codeNameOf(error.code)}${relays}`;
};

/** Where a failure was raised, in words. */
export const originWordsOf = (error: IErrorRecord): string | undefined => {
  if (error.origin === 'local') {
    return 'raised here, by this page’s router';
  }

  if (error.origin === 'peer') {
    return 'raised by the server';
  }

  if (error.origin === 'relayed') {
    const relays = error.relays ?? 1;

    return `raised beyond ${String(relays)} ${relays === 1 ? 'relay' : 'relays'}`;
  }

  return undefined;
};
