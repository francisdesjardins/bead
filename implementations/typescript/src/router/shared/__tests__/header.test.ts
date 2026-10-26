import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { CLIENT_FAILURES, CredentialScheme, FailureScope, SERVER_FAILURES } from '../constants';
import { FailureError } from '../errors';
import { headerBytesOf, readHeader, readPrefix, writeHeader } from '../header';
import type { Credential, EnvelopeHeader, SessionToken } from '../types';
import { fromHexadecimal, VECTORS } from './vectors';

// helpers

// 00 01 02 … 0f, as a token
const TOKEN = 'AAECAwQFBgcICQoLDA0ODw' as SessionToken;
// 16 zero bytes, which no token is
const ZERO_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA' as SessionToken;
const OPAQUE = Object.freeze({ scheme: CredentialScheme.OPAQUE, token: TOKEN });

/** The failure `read` throws, for its code and its side. */
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

// definition

// the vectors play once, as the C# side plays them: a retry would hide what fails there
test.describe.configure({ retries: 0 });

test.describe('writeHeader and readHeader', () => {
  for (const { bytes, header, name } of VECTORS.headers) {
    test(`reads ${name}, and writes it back`, () => {
      const expected = fromHexadecimal(bytes);
      const written = new Uint8Array(expected.length);

      expect(writeHeader(header, written)).toBe(expected.length);
      expect(written).toEqual(expected);
      expect(headerBytesOf(header)).toBe(expected.length);
      expect(readHeader(expected, SERVER_FAILURES)).toEqual({
        header,
        headerBytes: expected.length,
      });
    });
  }

  test('size each header by its kind and its blocks', () => {
    const request = { callId: 1, kind: 0x10, procedureId: 1, serviceId: 1 } as const;
    const result = { callId: 2, kind: 0x11 } as const;

    expect(
      [
        request,
        { ...request, destinationId: 1 },
        { ...request, credential: OPAQUE },
        { ...request, credential: OPAQUE, destinationId: 1 },
        { ...request, credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' } },
        { ...request, credential: { scheme: CredentialScheme.ELSEWHERE } },
      ].map(headerBytesOf)
    ).toEqual([12, 16, 32, 36, 24, 16]);
    expect(
      [
        result,
        { ...result, credential: OPAQUE },
        { ...result, total: 4_096 },
        { ...result, credential: { scheme: CredentialScheme.NONE }, total: 4_096 },
      ].map(headerBytesOf)
    ).toEqual([8, 28, 16, 20]);
    expect(headerBytesOf({ callId: 1, kind: 0x13 })).toBe(8);
    expect(headerBytesOf({ callId: 1, kind: 0x16 })).toBe(8);
  });

  test('write big-endian, and read every call id unsigned', () => {
    const bytes = new Uint8Array(8);

    writeHeader({ callId: 0x01020304, kind: 0x11 }, bytes);

    expect(bytes).toEqual(fromHexadecimal('A1 11 00 02  01 02 03 04'));

    for (const callId of [2 ** 31, 2 ** 32 - 1, 2 ** 31 + 1]) {
      writeHeader({ callId, kind: 0x11 }, bytes);

      expect(readHeader(bytes, SERVER_FAILURES)?.header.callId).toBe(callId);
    }
  });

  test('read an envelope where a pooled buffer holds it, at its own offset', () => {
    const request = fromHexadecimal('A1 10 00 03  00 00 00 03  00 02 00 01  68 69');
    const pool = new ArrayBuffer(request.length + 5);

    new Uint8Array(pool).fill(0xff);
    new Uint8Array(pool, 5).set(request);

    for (const bytes of [new Uint8Array(pool, 5), Buffer.from(pool, 5, request.length)]) {
      expect(bytes.byteOffset).toBe(5);
      expect(readPrefix(bytes, SERVER_FAILURES)).toEqual({ callId: 3, kind: 0x10, layout: 0xa1 });
      expect(readHeader(bytes, SERVER_FAILURES)?.header).toEqual({
        callId: 3,
        kind: 0x10,
        procedureId: 1,
        serviceId: 2,
      });
    }
  });
});

test.describe('writeHeader', () => {
  // spec 4.10
  test('refuses a field out of its range, naming it, before writing anything', () => {
    const bytes = new Uint8Array(16);

    for (const callId of [0, -1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => {
        return writeHeader({ callId, kind: 0x11 }, bytes);
      }).toThrow(
        new ProgrammerError(`callId is an integer from 1 to 4294967295, got ${String(callId)}`)
      );
    }

    expect(() => {
      return writeHeader({ callId: 1, kind: 0x10, procedureId: 1, serviceId: 0x10000 }, bytes);
    }).toThrow(/^serviceId is an integer from 1 to 65535/);
    // a caller without types
    expect(() => {
      return writeHeader({ callId: '1' as unknown as number, kind: 0x11 }, bytes);
    }).toThrow(new ProgrammerError('callId is an integer from 1 to 4294967295, got string'));
    expect(() => {
      return writeHeader({ callId: 1, kind: 0x10, procedureId: 0, serviceId: 1 }, bytes);
    }).toThrow(/^procedureId is an integer from 1 to 65535/);
    expect(() => {
      return writeHeader(
        { callId: 1, destinationId: 0, kind: 0x10, procedureId: 1, serviceId: 1 },
        bytes
      );
    }).toThrow(/^destinationId is an integer from 1 to 4294967295/);

    // each field at its bounds, and past them
    for (const value of [0, -1, 0x10000, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => {
        return writeHeader({ callId: 1, kind: 0x10, procedureId: 1, serviceId: value }, bytes);
      }).toThrow(
        new ProgrammerError(`serviceId is an integer from 1 to 65535, got ${String(value)}`)
      );
      expect(() => {
        return writeHeader({ callId: 1, kind: 0x10, procedureId: value, serviceId: 1 }, bytes);
      }).toThrow(
        new ProgrammerError(`procedureId is an integer from 1 to 65535, got ${String(value)}`)
      );
    }

    for (const destinationId of [0, -1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => {
        return writeHeader(
          { callId: 1, destinationId, kind: 0x10, procedureId: 1, serviceId: 1 },
          bytes
        );
      }).toThrow(
        new ProgrammerError(
          `destinationId is an integer from 1 to 4294967295, got ${String(destinationId)}`
        )
      );
    }

    expect(bytes).toEqual(new Uint8Array(16));

    // 0x1000 is a service and a procedure like any other
    writeHeader({ callId: 1, kind: 0x10, procedureId: 0x1000, serviceId: 0x1000 }, bytes);

    expect(bytes.subarray(8, 12)).toEqual(fromHexadecimal('10 00 10 00'));

    // the last of each range, and 2^31, are written as they are
    writeHeader(
      {
        callId: 2 ** 32 - 1,
        destinationId: 2 ** 32 - 1,
        kind: 0x10,
        procedureId: 0xffff,
        serviceId: 0xffff,
      },
      bytes
    );

    expect(bytes).toEqual(fromHexadecimal('A1 10 02 04  FF FF FF FF  FF FF FF FF  FF FF FF FF'));

    writeHeader(
      { callId: 2 ** 31, destinationId: 2 ** 31, kind: 0x10, procedureId: 1, serviceId: 1 },
      bytes
    );

    expect(bytes.subarray(0, 16)).toEqual(
      fromHexadecimal('A1 10 02 04  80 00 00 00  00 01 00 01  80 00 00 00')
    );
  });

  // spec 4.10
  test('refuses a destination on an answer, which names its call alone', () => {
    const bytes = new Uint8Array(16);

    for (const kind of [0x11, 0x12] as const) {
      expect(() => {
        return writeHeader({ callId: 3, destinationId: 5, kind } as EnvelopeHeader, bytes);
      }).toThrow(ProgrammerError);
    }

    expect(bytes).toEqual(new Uint8Array(16));
  });

  // spec 4.10
  test('refuses a credential its kind does not take, or its scheme does not hold', () => {
    // room for any header, so what is refused is the header, never the room
    const bytes = new Uint8Array(1_024);
    const requestOf = (credential: unknown): EnvelopeHeader => {
      return { callId: 1, credential, kind: 0x10, procedureId: 1, serviceId: 1 } as EnvelopeHeader;
    };

    // a token that is no session token's 16 bytes in base64url, which the C# side's types rule out
    for (const token of ['', 'AAECAwQFBgcICQoLDA0OD', 'AAECAwQFBgcICQoLDA0ODx']) {
      expect(() => {
        return writeHeader(
          {
            callId: 2,
            credential: { scheme: CredentialScheme.OPAQUE, token: token as SessionToken },
            kind: 0x11,
          },
          bytes
        );
      }, token).toThrow(ProgrammerError);
    }

    for (const [name, header] of [
      [
        'an OPAQUE token of 16 zero bytes on a request',
        requestOf({ scheme: CredentialScheme.OPAQUE, token: ZERO_TOKEN }),
      ],
      [
        'an OPAQUE token of 16 zero bytes on a result',
        {
          callId: 2,
          credential: { scheme: CredentialScheme.OPAQUE, token: ZERO_TOKEN },
          kind: 0x11,
        },
      ],
      ['NONE on a request', requestOf({ scheme: CredentialScheme.NONE })],
      [
        'a JWT on a result',
        { callId: 2, credential: { scheme: CredentialScheme.JWT, token: 'a' }, kind: 0x11 },
      ],
      [
        'ELSEWHERE on a failure',
        { callId: 2, credential: { scheme: CredentialScheme.ELSEWHERE }, kind: 0x12 },
      ],
      [
        'a scheme to come on a result',
        { callId: 2, credential: { bytes: new Uint8Array(0), scheme: 4 }, kind: 0x11 },
      ],
      ['a JWT of no character', requestOf({ scheme: CredentialScheme.JWT, token: '' })],
      [
        'a JWT of a character past U+00FF',
        requestOf({ scheme: CredentialScheme.JWT, token: 'a\u0100' }),
      ],
      [
        'a JWT of 1,005 characters',
        requestOf({ scheme: CredentialScheme.JWT, token: 'a'.repeat(1_005) }),
      ],
      // from here, what the C# side's types rule out: its twin says how
      [
        'bytes beside ELSEWHERE',
        requestOf({ bytes: new Uint8Array(4), scheme: CredentialScheme.ELSEWHERE }),
      ],
      ['a scheme to come without its bytes', requestOf({ scheme: 4 })],
      ['a scheme past 65535', requestOf({ bytes: new Uint8Array(0), scheme: 0x10000 })],
      ['a scheme that is no integer', requestOf({ bytes: new Uint8Array(0), scheme: 4.5 })],
      ['no credential at all', requestOf(null)],
    ] as const) {
      expect(() => {
        return writeHeader(header as EnvelopeHeader, bytes);
      }, name).toThrow(ProgrammerError);
      expect(() => {
        return headerBytesOf(header as EnvelopeHeader);
      }, name).toThrow(ProgrammerError);
    }

    expect(bytes).toEqual(new Uint8Array(1_024));
  });

  test('reads a JWT byte 0xE9 as U+00E9, and writes it back as the same byte', () => {
    const bytes = fromHexadecimal(
      'A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  E9 00 00 00'
    );
    const header: EnvelopeHeader = {
      callId: 3,
      credential: { scheme: CredentialScheme.JWT, token: '\u00e9' },
      kind: 0x10,
      procedureId: 1,
      serviceId: 2,
    };
    const written = new Uint8Array(bytes.length);

    expect(readHeader(bytes, SERVER_FAILURES)).toEqual({ header, headerBytes: bytes.length });
    expect(writeHeader(header, written)).toBe(bytes.length);
    expect(written).toEqual(bytes);
  });

  test('writes the padding over whatever the bytes held', () => {
    const credential: Credential = { scheme: CredentialScheme.JWT, token: 'a' };
    const bytes = new Uint8Array(20).fill(0xff);

    writeHeader({ callId: 3, credential, kind: 0x10, procedureId: 1, serviceId: 2 }, bytes);

    expect(bytes).toEqual(
      fromHexadecimal('A1 10 08 05  00 00 00 03  00 02 00 01  00 02 00 01  61 00 00 00')
    );
  });

  test('carries a 64-bit field whole, its high word first, from 0 to 2⁵³ − 1', () => {
    for (const creditEnd of [0, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1, 2 ** 53 - 1]) {
      const header: EnvelopeHeader = { callId: 1, creditEnd, kind: 0x15 };
      const bytes = new Uint8Array(16);

      writeHeader(header, bytes);

      expect(readHeader(bytes, SERVER_FAILURES)?.header, String(creditEnd)).toEqual(header);
    }

    const bytes = new Uint8Array(16);

    writeHeader({ callId: 1, creditEnd: 2 ** 32 + 5, kind: 0x15 }, bytes);

    expect(bytes.subarray(8)).toEqual(fromHexadecimal('00 00 00 01 00 00 00 05'));
  });

  test('refuses an offset, an end or a total that is not a whole number from 0 to 2⁵³ − 1', () => {
    const refusalOf = (field: string, value: number): ProgrammerError => {
      return new ProgrammerError(
        `${field} is a whole number from 0 to 2⁵³ − 1, got ${String(value)}`
      );
    };

    for (const value of [-1, 1.5, 2 ** 53, Number.NaN]) {
      expect(() => {
        return writeHeader(
          { callId: 1, isLast: true, kind: 0x14, offset: value },
          new Uint8Array(16)
        );
      }, String(value)).toThrow(refusalOf('offset', value));
      expect(() => {
        return writeHeader({ callId: 1, creditEnd: value, kind: 0x15 }, new Uint8Array(16));
      }, String(value)).toThrow(refusalOf('creditEnd', value));
      expect(() => {
        return writeHeader({ callId: 1, kind: 0x11, total: value }, new Uint8Array(16));
      }, String(value)).toThrow(refusalOf('total', value));
    }
  });

  test('names what a caller without types gave for a 64-bit field', () => {
    expect(() => {
      return writeHeader(
        { callId: 1, creditEnd: '8', kind: 0x15 } as unknown as EnvelopeHeader,
        new Uint8Array(16)
      );
    }).toThrow('creditEnd is a whole number from 0 to 2⁵³ − 1, got string');
  });

  test('refuses a chunk that does not say whether it is the last, and a total on another kind', () => {
    expect(() => {
      return writeHeader(
        { callId: 1, kind: 0x14, offset: 0 } as unknown as EnvelopeHeader,
        new Uint8Array(16)
      );
    }).toThrow(ProgrammerError);

    for (const kind of [0x12, 0x13, 0x14, 0x15, 0x16]) {
      expect(() => {
        return writeHeader(
          { callId: 1, isLast: true, kind, offset: 0, total: 8 } as unknown as EnvelopeHeader,
          new Uint8Array(32)
        );
      }, String(kind)).toThrow(ProgrammerError);
    }
  });

  // spec 4.10
  test('refuses a kind it does not write, a block its kind lacks, and bytes too few', () => {
    expect(() => {
      return writeHeader({ callId: 1, kind: 0x17 } as unknown as EnvelopeHeader, new Uint8Array(8));
    }).toThrow(ProgrammerError);
    expect(() => {
      return writeHeader(
        { callId: 1, destinationId: 1, kind: 0x13 } as EnvelopeHeader,
        new Uint8Array(12)
      );
    }).toThrow(ProgrammerError);
    expect(() => {
      return writeHeader(
        { callId: 1, credential: OPAQUE, kind: 0x16 } as EnvelopeHeader,
        new Uint8Array(28)
      );
    }).toThrow(ProgrammerError);
    expect(() => {
      return writeHeader({ callId: 1, kind: 0x11 }, new Uint8Array(7));
    }).toThrow(ProgrammerError);
  });

  test('opens a subscription on a request alone', () => {
    for (const kind of [0x11, 0x12, 0x13, 0x16]) {
      expect(() => {
        return writeHeader(
          { callId: 1, kind, opensSubscription: true } as unknown as EnvelopeHeader,
          new Uint8Array(8)
        );
      }, String(kind)).toThrow(ProgrammerError);
    }
  });

  test('paces a request that opens a subscription, and a credit, alone', () => {
    for (const header of [
      { callId: 1, kind: 0x10, paced: true, procedureId: 1, serviceId: 1 },
      { callId: 1, kind: 0x11, paced: true },
      { callId: 1, kind: 0x12, paced: true },
      { callId: 1, kind: 0x13, paced: true },
      { callId: 1, isLast: true, kind: 0x14, offset: 0, paced: true },
      { callId: 1, kind: 0x16, paced: true },
    ]) {
      expect(() => {
        return writeHeader(header as unknown as EnvelopeHeader, new Uint8Array(16));
      }, String(header.kind)).toThrow(
        new ProgrammerError(
          `a 0x${header.kind.toString(16)} header paces nothing: a request that opens a subscription does, or a credit`
        )
      );
    }
  });

  test('writes no destination block for a destination left undefined', () => {
    const header: EnvelopeHeader = {
      callId: 1,
      destinationId: undefined,
      kind: 0x10,
      procedureId: 1,
      serviceId: 2,
    };
    const bytes = new Uint8Array(12);

    expect(writeHeader(header, bytes)).toBe(12);
    expect(bytes).toEqual(fromHexadecimal('A1 10 00 03  00 00 00 01  00 02 00 01'));
  });
});

test.describe('readPrefix', () => {
  for (const { bytes, name, prefix } of VECTORS.prefixes) {
    test(`reads ${name}`, () => {
      expect(readPrefix(fromHexadecimal(bytes), CLIENT_FAILURES)).toEqual(prefix);
    });
  }

  for (const { bytes, code, name } of VECTORS.prefixRefusals) {
    test(`refuses ${name}`, () => {
      const failure = failureOf(() => {
        return readPrefix(fromHexadecimal(bytes), CLIENT_FAILURES);
      });

      expect(failure.code).toBe(code);
      expect(failure.side).toBe('client');
    });
  }
});

test.describe('readHeader', () => {
  for (const { bytes, header, name, side } of VECTORS.reads) {
    test(`reads ${name}`, () => {
      const read = readHeader(
        fromHexadecimal(bytes),
        side === 'client' ? CLIENT_FAILURES : SERVER_FAILURES
      );

      expect(read).toEqual(
        // * the bytes the header took as it was read, which a writer may write fewer of
        header === null ? undefined : { header, headerBytes: fromHexadecimal(bytes).length }
      );
    });
  }

  for (const { bytes, code, detail, name } of [
    ...VECTORS.prefixRefusals,
    ...VECTORS.headerRefusals,
  ]) {
    test(`refuses ${name}`, () => {
      const failure = failureOf(() => {
        return readHeader(fromHexadecimal(bytes), SERVER_FAILURES);
      });

      expect(failure).toMatchObject({
        code,
        origin: 'local',
        scope: FailureScope.PROTOCOL,
        side: 'server',
      });

      if (detail !== undefined) {
        expect(failure.detail).toBe(detail);
      }
    });
  }

  test('raises its failures as the side of the table it is given', () => {
    const failure = failureOf(() => {
      return readHeader(fromHexadecimal('A1 11 00 02  00 00 00 00'), CLIENT_FAILURES);
    });

    expect(failure).toMatchObject({ origin: 'local', side: 'client' });
  });
});
