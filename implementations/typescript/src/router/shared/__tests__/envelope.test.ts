import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import {
  EnvelopeKind,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { bytesOf, readEnvelope, readFailure, writeEnvelope, writeFailure } from '../envelope';
import { FailureError } from '../errors';
import type { Envelope, OutgoingEnvelope } from '../types';
import { fromHexadecimal, type IEnvelopeVector, VECTORS } from './vectors';

// helpers

const ascii = (text: string): string => {
  return [...new TextEncoder().encode(text)]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0');
    })
    .join(' ');
};

/** The failure `read` throws. */
const failureOf = (read: () => unknown): FailureError => {
  try {
    read();
  } catch (reason) {
    if (reason instanceof FailureError) {
      return reason;
    }

    throw reason;
  }

  throw new Error('read did not fail');
};

const limits = { failures: SERVER_FAILURES, maximumEnvelopeBytes: 64 };

/** An envelope as a vector writes it, as this package holds one: its payload as bytes. */
const envelopeOf = ({ failure, header, kind, payload }: IEnvelopeVector): Envelope => {
  return {
    header,
    kind,
    ...(failure === undefined ? {} : { failure }),
    ...(payload === undefined ? {} : { payload: fromHexadecimal(payload) }),
  } as Envelope;
};

// definition

// the vectors play once, as the C# side plays them: a retry would hide what fails there
test.describe.configure({ retries: 0 });

test.describe('readEnvelope and writeEnvelope', () => {
  for (const { bytes, envelope, name } of VECTORS.envelopes) {
    test(`read ${name}, and write it back`, () => {
      const expected = envelopeOf(envelope);

      expect(readEnvelope(fromHexadecimal(bytes), limits)).toEqual(expected);
      expect(writeEnvelope(expected as OutgoingEnvelope)).toEqual(fromHexadecimal(bytes));
    });
  }

  for (const { bytes, code, detail, maximumEnvelopeBytes, name } of VECTORS.envelopeRefusals) {
    test(`refuse ${name}`, () => {
      expect(
        failureOf(() => {
          return readEnvelope(fromHexadecimal(bytes), {
            ...limits,
            ...(maximumEnvelopeBytes === undefined ? {} : { maximumEnvelopeBytes }),
          });
        })
      ).toMatchObject({
        code,
        origin: 'local',
        scope: FailureScope.PROTOCOL,
        side: 'server',
        ...(detail === undefined ? {} : { detail }),
      });
    });
  }

  test('skip an advisory envelope', () => {
    expect(readEnvelope(fromHexadecimal('A1 80 00 02  00 00 00 03 | 01'), limits)).toBeUndefined();
  });

  test('copy the payload, even out of a pooled Buffer', () => {
    const bytes = fromHexadecimal(`A1 11 00 02  00 00 00 03 | 01 02 03`);
    const pool = Buffer.alloc(bytes.length + 4, 0xff);

    pool.set(bytes, 4);

    const envelope = readEnvelope(pool.subarray(4), limits);

    pool.fill(0);

    expect(envelope).toMatchObject({ payload: Uint8Array.of(1, 2, 3) });
    expect(envelope?.kind === EnvelopeKind.RESULT && envelope.payload.buffer).not.toBe(pool.buffer);
  });

  test('write no chunk without a byte', () => {
    expect(() => {
      return writeEnvelope({
        header: { callId: 7, isLast: true, kind: EnvelopeKind.CHUNK, offset: 0 },
        kind: EnvelopeKind.CHUNK,
        payload: new Uint8Array(0),
      });
    }).toThrow(ProgrammerError);
  });

  test('cut a failure’s detail to the bytes it is given, a character whole', () => {
    const bytes = writeEnvelope(
      {
        failure: { code: 1, detail: 'abcdéf', scope: FailureScope.PROTOCOL },
        header: { callId: 3, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      },
      5
    );

    expect(readEnvelope(bytes, limits)).toMatchObject({ failure: { detail: 'abcd' } });
  });

  test('take an envelope of the largest size, and refuse one byte more', () => {
    const exact = new Uint8Array(64);

    exact.set(fromHexadecimal('A1 11 00 02  00 00 00 03'));

    expect(readEnvelope(exact, limits)?.kind).toBe(EnvelopeKind.RESULT);

    const larger = new Uint8Array(65);

    larger.set(fromHexadecimal('A1 11 00 02  00 00 00 03'));

    expect(
      failureOf(() => {
        return readEnvelope(larger, limits);
      })
    ).toMatchObject({ code: ProtocolCode.ENVELOPE_TOO_LARGE, side: 'server' });

    // what is not an envelope is malformed, however large
    larger.set(fromHexadecimal('0A'));

    expect(
      failureOf(() => {
        return readEnvelope(larger, limits);
      }).code
    ).toBe(ProtocolCode.ENVELOPE_MALFORMED);
  });

  test('refuse an envelope whose kind is not its header’s', () => {
    expect(() => {
      return writeEnvelope({
        header: { callId: 3, kind: 0x11 },
        kind: EnvelopeKind.NOTIFICATION,
        payload: new Uint8Array(0),
      } as unknown as Parameters<typeof writeEnvelope>[0]);
    }).toThrow(ProgrammerError);
  });

  test('narrow on the kind, down to never', () => {
    const describe = (envelope: Envelope): string => {
      switch (envelope.kind) {
        case EnvelopeKind.FAILURE:
          expect('payload' in envelope).toBe(false);
          // @ts-expect-error a failure carries its record, not a payload
          void envelope.payload;

          return envelope.failure.detail;
        case EnvelopeKind.CHUNK:
        case EnvelopeKind.NOTIFICATION:
        case EnvelopeKind.REQUEST:
        case EnvelopeKind.RESULT:
          return String(envelope.payload.length);
        case EnvelopeKind.CREDIT:
          expect('payload' in envelope).toBe(false);
          // @ts-expect-error a credit carries nothing
          void envelope.payload;

          return String(envelope.header.creditEnd);
        case EnvelopeKind.CANCEL:
          expect('payload' in envelope).toBe(false);
          // @ts-expect-error a cancel carries nothing
          void envelope.payload;

          return 'cancel';
        default: {
          const none: never = envelope;

          return none;
        }
      }
    };

    expect(
      describe({
        failure: { code: 19, detail: 'd', relays: 0, scope: 0 },
        header: { callId: 1, kind: 0x12 },
        kind: 0x12,
      })
    ).toBe('d');
    expect(
      describe({ header: { callId: 1, kind: 0x13 }, kind: 0x13, payload: Uint8Array.of(1) })
    ).toBe('1');
    expect(
      describe({
        header: { callId: 1, isLast: true, kind: 0x14, offset: 3 },
        kind: 0x14,
        payload: Uint8Array.of(1, 2),
      })
    ).toBe('2');
    expect(describe({ header: { callId: 1, creditEnd: 9, kind: 0x15 }, kind: 0x15 })).toBe('9');
    expect(describe({ header: { callId: 1, kind: 0x16 }, kind: 0x16 })).toBe('cancel');
  });
});

test.describe('readFailure', () => {
  const options = { failures: SERVER_FAILURES };

  for (const { failure, maximumDetailBytes, name, record } of VECTORS.failures) {
    test(`reads ${name}`, () => {
      expect(readFailure(fromHexadecimal(record), { ...options, maximumDetailBytes })).toEqual(
        failure
      );
    });
  }

  for (const { code, name, record } of VECTORS.failureRefusals) {
    test(`refuses ${name}`, () => {
      expect(
        failureOf(() => {
          return readFailure(fromHexadecimal(record), options);
        })
      ).toMatchObject({ code, origin: 'local', scope: FailureScope.PROTOCOL, side: 'server' });
    });
  }

  test('cuts a long detail at the default limit, back to the start of the character cut', () => {
    const record = (detail: Uint8Array): Uint8Array => {
      const bytes = new Uint8Array(4 + detail.length);

      bytes.set(fromHexadecimal('00 13 00 00'));
      bytes.set(detail, 4);

      return bytes;
    };
    const encode = (text: string): Uint8Array => {
      return new TextEncoder().encode(text);
    };

    expect(readFailure(record(encode('a'.repeat(1_025))), options).detail).toBe('a'.repeat(1_024));
    expect(readFailure(record(encode(`${'a'.repeat(1_021)}😀`)), options).detail).toBe(
      'a'.repeat(1_021)
    );
    expect(readFailure(record(encode(`${'a'.repeat(1_020)}😀`)), options).detail).toBe(
      `${'a'.repeat(1_020)}😀`
    );
  });
});

test.describe('writeFailure', () => {
  test('refuses a code that is not an integer from 1 to 65535, or a scope that is neither', () => {
    for (const code of [0, 65_536, 1.5, -1, Number.NaN]) {
      expect(() => {
        return writeFailure({ code, scope: FailureScope.APPLICATION });
      }).toThrow(ProgrammerError);
    }

    expect(() => {
      return writeFailure({ code: 1, scope: 2 as FailureScope });
    }).toThrow(ProgrammerError);
    expect(writeFailure({ code: 0x1000, scope: FailureScope.APPLICATION })).toEqual(
      fromHexadecimal('10 00 00 01')
    );
    expect(writeFailure({ code: 0xffff, scope: FailureScope.PROTOCOL })).toEqual(
      fromHexadecimal('FF FF 00 00')
    );
  });

  test('writes the relays a failure crossed, from 0 to 255, and refuses any other count', () => {
    for (const relays of [0, 1, 255]) {
      const record = writeFailure({ code: 19, relays, scope: FailureScope.PROTOCOL });

      expect(record[2], String(relays)).toBe(relays);
      expect(readFailure(record, { failures: SERVER_FAILURES }).relays).toBe(relays);
    }

    expect(writeFailure({ code: 19, scope: FailureScope.PROTOCOL })[2]).toBe(0);

    for (const relays of [256, -1, 1.5, Number.NaN]) {
      expect(() => {
        return writeFailure({ code: 19, relays, scope: FailureScope.PROTOCOL });
      }, String(relays)).toThrow(
        new ProgrammerError(
          `a failure crossed an integer from 0 to 255 relays, not ${String(relays)}`
        )
      );
    }
  });

  // spec 7.4
  test('cuts the detail at the limit, at a character’s boundary', () => {
    const detailOf = (detail: string): string => {
      return new TextDecoder().decode(
        writeFailure({ code: 1, detail, scope: FailureScope.PROTOCOL }).subarray(4)
      );
    };

    expect(LIMIT_DEFAULTS.maximumDetailBytes).toBe(1_024);
    expect(detailOf('a'.repeat(1_100))).toBe('a'.repeat(1_024));
    expect(detailOf(`${'a'.repeat(1_022)}é`)).toBe(`${'a'.repeat(1_022)}é`);
    expect(detailOf(`${'a'.repeat(1_023)}é`)).toBe('a'.repeat(1_023));
    expect(detailOf(`${'a'.repeat(1_022)}€`)).toBe('a'.repeat(1_022));
    expect(detailOf(`${'a'.repeat(1_021)}😀`)).toBe('a'.repeat(1_021));
    expect(detailOf(`${'a'.repeat(1_020)}😀`)).toBe(`${'a'.repeat(1_020)}😀`);
    expect(detailOf('')).toBe('');
    expect(writeFailure({ code: 1, detail: 'abcdef', scope: FailureScope.PROTOCOL }, 3)).toEqual(
      fromHexadecimal(`00 01 00 00  ${ascii('abc')}`)
    );
  });

  // spec 7.4
  test('writes a lone surrogate as U+FFFD', () => {
    expect(writeFailure({ code: 1, detail: '\uD800', scope: FailureScope.PROTOCOL })).toEqual(
      fromHexadecimal('00 01 00 00  EF BF BD')
    );
  });
});

test.describe('bytesOf', () => {
  test('reads a buffer, or a view on one at its own offset', () => {
    const buffer = Uint8Array.of(1, 2, 3, 4).buffer;

    expect(bytesOf(buffer)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(bytesOf(new Uint8Array(buffer, 1, 2))).toEqual(Uint8Array.of(2, 3));
    expect(bytesOf(Buffer.from([5, 6]))).toEqual(Uint8Array.of(5, 6));
    expect(bytesOf(new DataView(buffer, 2))).toEqual(Uint8Array.of(3, 4));
  });

  test('refuses text and a Blob, which are not envelopes', () => {
    expect(() => {
      return bytesOf('text');
    }).toThrow(new TypeError('an envelope is binary, not a string'));
    expect(() => {
      return bytesOf(new Blob(['binary']));
    }).toThrow(new TypeError('an envelope is binary, not a Blob'));
  });
});
