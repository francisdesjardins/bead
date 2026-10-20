// ── Fuzz target: the WebSocket handshake's judgement ──────────────────────────

// Raw bytes as an upgrade, judged as the WebSocket transport's server judges a request at its
// address before its 101 (spec 15.2). The first byte picks what the rest is, modulo the twelve
// below: the whole head, its lines parted by line feeds, each carriage return that ends one dropped,
// to its first empty line; or, in RFC 6455 §1.3's handshake to a host the server takes, its request
// line, or one field's lines in place of that field's, each line feed parting two of them. The rest
// is one character an octet, as Node hands a field's octets on in Latin-1. What Node's parser refuses
// before the judgement reads it is not judged: a request line not of a token, a target and
// `HTTP/1.0` or `HTTP/1.1`, a field line with no name that is a token before its colon. Node trims
// each value of its spaces and tabs, and so does this. The judgement answers a refusal, or none; the
// refusal tells of the request, and an upgrade it takes carries its credential: any error is a
// finding. The C# side's `WsHandshakeTarget` is its twin, slot for slot, with the same server.

// dependencies

import { credentialOf } from '../../src/transport/server/hosts-and-origins';
import {
  type IHandshakeRequestLike,
  refusalOfHandshake,
  toldOfHandshake,
} from '../../src/transport/server/ws-handshake';

// constants

// the server the upgrade comes to: the host it takes, besides those every server takes, and an
// origin of another's it takes
const SERVER = Object.freeze({
  hosts: Object.freeze(['bead.test']),
  origins: Object.freeze(['https://bead.test']),
});

// RFC 6455 §1.3's handshake, to a host the server takes
const REQUEST_LINE = 'GET / HTTP/1.1';
const HANDSHAKE: readonly (readonly [string, string])[] = Object.freeze([
  ['host', 'bead.test'],
  ['upgrade', 'websocket'],
  ['connection', 'Upgrade'],
  ['sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ=='],
  ['sec-websocket-version', '13'],
]);

// the parts, by the first byte's slot: the head, its request line, then each field by its name
const SLOTS = Object.freeze({ HEAD: 0, REQUEST_LINE: 1 });
const FIELDS = Object.freeze([
  'host',
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'origin',
  'authorization',
  'content-length',
  'transfer-encoding',
]);
const SLOT_COUNT = 2 + FIELDS.length;

// a token (RFC 9110 §5.6.2), and the versions Node's parser reads
const TOKEN = /^[\d!#$%&'*+\-.^_`|~A-Za-z]+$/u;
const VERSION = /^HTTP\/1\.[01]$/u;

// helpers

// a value without the spaces and tabs around it, as Node hands it on
const trimmed = (value: string): string => {
  return value.replaceAll(/^[\t ]+|[\t ]+$/gu, '');
};

// a field line as Node's parser reads it, its name and its value; none for one it refuses
const fieldOf = (line: string): readonly [string, string] | undefined => {
  const colon = line.indexOf(':');
  const name = line.slice(0, Math.max(colon, 0));

  return TOKEN.test(name) ? [name, trimmed(line.slice(colon + 1))] : undefined;
};

// the head the bytes stand for: its request line and its field lines
const headOf = (data: Uint8Array): { fieldLines: readonly string[]; requestLine: string } => {
  const value = Buffer.from(data.subarray(1)).toString('latin1');
  const slot = (data[0] ?? 0) % SLOT_COUNT;
  const handshake = HANDSHAKE.map(([name, field]) => {
    return `${name}: ${field}`;
  });

  if (slot === SLOTS.HEAD) {
    const lines = value.split('\n').map((line) => {
      return line.endsWith('\r') ? line.slice(0, -1) : line;
    });
    const end = lines.indexOf('', 1);

    return {
      fieldLines: lines.slice(1, end === -1 ? undefined : end),
      requestLine: lines[0] ?? '',
    };
  }

  if (slot === SLOTS.REQUEST_LINE) {
    return { fieldLines: handshake, requestLine: value };
  }

  const name = FIELDS[slot - 2] ?? '';

  return {
    fieldLines: [
      ...handshake.filter((line) => {
        return !line.startsWith(`${name}:`);
      }),
      ...value.split('\n').map((line) => {
        return `${name}: ${line}`;
      }),
    ],
    requestLine: REQUEST_LINE,
  };
};

// the request Node hands on for the head, as the judgement reads it; none for one Node refuses
const requestOf = ({
  fieldLines,
  requestLine,
}: {
  fieldLines: readonly string[];
  requestLine: string;
}): IHandshakeRequestLike | undefined => {
  const [method = '', url = '', version = '', ...rest] = requestLine.split(' ');
  const fields = fieldLines.map(fieldOf);

  if (!TOKEN.test(method) || url === '' || !VERSION.test(version) || rest.length > 0) {
    return undefined;
  }

  const rawHeaders: string[] = [];

  for (const field of fields) {
    if (field === undefined) {
      return undefined;
    }

    rawHeaders.push(...field);
  }

  return { httpVersion: version.slice('HTTP/'.length), method, rawHeaders, url };
};

// the lines of the field `name`, as the server reads them
const linesOf = (request: IHandshakeRequestLike, name: string): string[] => {
  const lines: string[] = [];
  const { rawHeaders } = request;

  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      lines.push(rawHeaders[index + 1] ?? '');
    }
  }

  return lines;
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const request = requestOf(headOf(data));

  if (request === undefined) {
    return;
  }

  const refusal = refusalOfHandshake(request, SERVER);

  toldOfHandshake(request);

  // an upgrade the judgement takes carries its credential, but from a page
  if (refusal === undefined && linesOf(request, 'origin').length === 0) {
    credentialOf(linesOf(request, 'authorization'));
  }
};
