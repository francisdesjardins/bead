// ── Transcoding exchanges ─────────────────────────────────────────────────────

// `spec/transcoding.json`'s exchanges, each played over real sockets against a fixture's port, as
// its bytes: the gateway on its own listener, or mounted on an application's server.

// dependencies

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { fromHexadecimal } from '../../router/shared/__tests__/vectors';
import { OPENAPI_DOCUMENT } from './generated/bead_http';
import type { ITranscodingFixture } from './transcoding-service';

// interfaces

/** A response's field as an exchange expects it: its value, absent, or an entity tag's shape. */
type ExpectedField = string | null | { capture?: string; shape: 'etag' };

/** An entry of the file's `exchanges`. */
export interface IExchangeEntry {
  clauses: string[];
  name: string;
  options?: Record<string, unknown>;
  realTime?: true;
  steps: {
    close?: string;
    expect?: {
      body?: string;
      bodyBytes?: string;
      fields: Record<string, ExpectedField>;
      status: number;
      stream?: string;
    };
    on?: string;
    send?: { body?: string; head: string };
    until?: Record<string, number>;
  }[];
}

/** A socket of an exchange, and what came on it so far. */
export interface IPeer {
  readonly method: string;
  readonly received: Buffer[];
  readonly socket: Socket;
  /** Settles once more came, or the socket ended. */
  next: () => Promise<void>;
  isEnded: boolean;
  taken: number;
}

/** A response as a peer read it: its status, its fields by lower-case name, and its body. */
interface IRead {
  body: Buffer;
  fields: Map<string, string>;
  status: number;
}

// constants

const EXCHANGES_FILE = JSON.parse(
  readFileSync(new URL('../../../../../spec/transcoding.json', import.meta.url), 'utf8')
) as { defaults: Record<string, unknown>; exchanges: IExchangeEntry[] };

/** The file's exchanges, in its order. */
export const EXCHANGES: readonly IExchangeEntry[] = EXCHANGES_FILE.exchanges;

// how long an exchange waits for what it expects, on the real clock
const PATIENCE = 5_000;

const HEAD_END = Buffer.from('\r\n\r\n');

// helpers

/** Opens a socket to the gateway, and writes `head` and `body` on it. */
const openPeer = (port: number, { body, head }: { body: Uint8Array; head: string }): IPeer => {
  const socket = connect({ host: '127.0.0.1', port });
  const received: Buffer[] = [];
  let wake: (() => void) | undefined;
  const peer: IPeer = {
    isEnded: false,
    taken: 0,
    method: head.split(' ')[0] ?? '',
    next: () => {
      return new Promise((resolve) => {
        wake = resolve;
      });
    },
    received,
    socket,
  };
  const woken = (): void => {
    const waking = wake;

    wake = undefined;
    waking?.();
  };

  socket.on('data', (bytes) => {
    received.push(bytes);
    woken();
  });
  socket.on('close', () => {
    peer.isEnded = true;
    woken();
  });
  socket.on('error', () => {
    peer.isEnded = true;
    woken();
  });
  socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));

  return peer;
};

/** A chunked body's bytes so far, and whether its last chunk came. */
const dechunk = (bytes: Buffer): { body: Buffer; isWhole: boolean; taken: number } => {
  const parts: Buffer[] = [];
  let at = 0;

  for (;;) {
    const end = bytes.indexOf('\r\n', at);

    if (end === -1) {
      return { body: Buffer.concat(parts), isWhole: false, taken: at };
    }

    const size = Number.parseInt(bytes.subarray(at, end).toString('latin1'), 16);

    if (size === 0) {
      let trailer = end + 2;

      for (;;) {
        const lineEnd = bytes.indexOf('\r\n', trailer);

        if (lineEnd === -1) {
          return { body: Buffer.concat(parts), isWhole: false, taken: at };
        }

        if (lineEnd === trailer) {
          return { body: Buffer.concat(parts), isWhole: true, taken: lineEnd + 2 };
        }

        trailer = lineEnd + 2;
      }
    }

    if (bytes.length < end + 2 + size + 2) {
      parts.push(bytes.subarray(end + 2));

      return { body: Buffer.concat(parts), isWhole: false, taken: at };
    }

    parts.push(bytes.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
};

// definition

/**
 * What came on `peer` as one response: its head, then its body by its length, de-chunked to its
 * end, or to its socket's end; for a stream, as soon as its body begins with `stream`.
 */
export const readOn = async (
  peer: IPeer,
  { stream }: { stream?: string | undefined }
): Promise<IRead> => {
  const deadline = performance.now() + PATIENCE;

  for (;;) {
    const bytes = Buffer.concat(peer.received).subarray(peer.taken);
    const at = bytes.indexOf(HEAD_END);

    if (at !== -1) {
      const [statusLine = '', ...lines] = bytes.subarray(0, at).toString('latin1').split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const fields = new Map<string, string>();

      for (const line of lines) {
        const colon = line.indexOf(':');

        // * a field given twice is one, its values joined (RFC 9110 5.3), as the C# side reads it
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        const before = fields.get(name);

        fields.set(name, before === undefined ? value : `${before}, ${value}`);
      }

      const rest = bytes.subarray(at + HEAD_END.length);
      const length = fields.get('content-length');
      const isChunked = fields.get('transfer-encoding') === 'chunked';

      if (
        peer.method === 'HEAD' ||
        (status >= 100 && status < 200) ||
        status === 204 ||
        status === 304
      ) {
        peer.taken += at + HEAD_END.length;

        return { body: Buffer.alloc(0), fields, status };
      }

      if (!isChunked && length !== undefined && rest.length >= Number(length)) {
        peer.taken += at + HEAD_END.length + Number(length);

        return { body: rest.subarray(0, Number(length)), fields, status };
      }

      if (isChunked) {
        const { body, isWhole, taken } = dechunk(rest);

        if (
          isWhole ||
          (taken > 0 && stream !== undefined && body.toString('utf8').startsWith(stream))
        ) {
          peer.taken += at + HEAD_END.length + taken;

          return { body, fields, status };
        }
      }

      if (length === undefined && !isChunked && peer.isEnded) {
        peer.taken += bytes.length;

        return { body: rest, fields, status };
      }
    }

    if (peer.isEnded && at === -1) {
      throw new Error('the socket ended before a response came');
    }

    if (performance.now() > deadline) {
      throw new Error(`no whole response within ${String(PATIENCE)} ms`);
    }

    await Promise.race([peer.next(), sleep(50)]);
  }
};

/** A gateway's options of the file's defaults and an exchange's own, by the gateway's names. */
export const gatewayOptionsOf = (entry: IExchangeEntry): Record<string, unknown> => {
  const { document, problemTypes, ...rest } = { ...EXCHANGES_FILE.defaults, ...entry.options };

  return {
    ...rest,
    ...(document === false ? { document: undefined } : {}),
    problemTypes: problemTypes ?? undefined,
  };
};

/** Plays `entry`'s steps against the fixture's port, each response held to what it expects. */
export const playExchange = async (
  entry: IExchangeEntry,
  fixture: Pick<ITranscodingFixture, 'counts' | 'port'>
): Promise<void> => {
  const peers = new Map<string, IPeer>();
  const captured = new Map<string, string>();
  const etag = `"${createHash('sha256').update(OPENAPI_DOCUMENT).digest('hex')}"`;

  try {
    for (const step of entry.steps) {
      if (step.send !== undefined && step.on !== undefined) {
        let head = step.send.head.replaceAll('{host}', `127.0.0.1:${String(fixture.port)}`);

        for (const [name, value] of captured) {
          head = head.replaceAll(`{${name}}`, value);
        }

        peers.set(
          step.on,
          openPeer(fixture.port, { body: fromHexadecimal(step.send.body ?? ''), head })
        );
      } else if (step.expect !== undefined && step.on !== undefined) {
        const peer = peers.get(step.on);

        if (peer === undefined) {
          throw new Error(`no exchange ${step.on}`);
        }

        const read = await readOn(peer, { stream: step.expect.stream });

        expect(read.status, step.on).toBe(step.expect.status);

        for (const [name, value] of Object.entries(step.expect.fields)) {
          const held = read.fields.get(name.toLowerCase());

          if (value === null) {
            expect(held, name).toBeUndefined();
          } else if (typeof value === 'string') {
            expect(held, name).toBe(value);
          } else {
            expect(held, name).toBe(etag);

            if (value.capture !== undefined && held !== undefined) {
              captured.set(value.capture, held);
            }
          }
        }

        if (step.expect.bodyBytes !== undefined) {
          expect([...read.body]).toEqual([...fromHexadecimal(step.expect.bodyBytes)]);
        } else if (step.expect.stream !== undefined) {
          expect(read.body.toString('utf8').startsWith(step.expect.stream)).toBe(true);
        } else {
          expect(read.body.toString('utf8')).toBe(
            (step.expect.body ?? '').replaceAll('{document}', OPENAPI_DOCUMENT)
          );
        }
      } else if (step.close !== undefined) {
        peers.get(step.close)?.socket.destroy();
      } else if (step.until !== undefined) {
        const deadline = performance.now() + PATIENCE;

        for (const [name, value] of Object.entries(step.until)) {
          while ((fixture.counts as Record<string, number>)[name] !== value) {
            if (performance.now() > deadline) {
              throw new Error(`${name} never reached ${String(value)}`);
            }

            await sleep(10);
          }
        }
      }
    }
  } finally {
    for (const peer of peers.values()) {
      peer.socket.destroy();
    }
  }
};
