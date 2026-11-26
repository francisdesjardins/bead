import { once } from 'node:events';
import { connect as connectTLS, type TLSSocket } from 'node:tls';
import { BEAD_MEDIA_TYPE } from '../../shared/constants';
import { closedAfter, host } from './http-transport-server-fixtures';
import { TLS_FIXTURE } from './tls-fixture';

/**
 * What the HTTP/2 tests of a transport and a gateway share: a request written frame by frame, so
 * that it carries what Node's client refuses to send.
 */

// interfaces

/** Where a raw `POST` over HTTP/2 goes, and the type of the body it declares. */
export interface IRawRequestOptions {
  /** Its `content-type`; Bead's media type unless given. */
  contentType?: string;
  /** Leaves the stream open after its head, with no body sent. */
  isOpen?: boolean;
  /** Its `:path`; `/bead` unless given. */
  path?: string;
}

// helpers

// an HTTP/2 frame (RFC 9113 §4.1): its type, its flags, its stream and its payload
const frameOf = (
  type: number,
  {
    flags = 0,
    payload = Buffer.alloc(0),
    stream = 0,
  }: { flags?: number; payload?: Buffer; stream?: number }
) => {
  const head = Buffer.alloc(9);

  head.writeUIntBE(payload.length, 0, 3);
  head.writeUInt8(type, 3);
  head.writeUInt8(flags, 4);
  head.writeUInt32BE(stream, 5);

  return Buffer.concat([head, payload]);
};

// a field as a literal never indexed nor Huffman-coded (RFC 7541 §6.2.3), its name and its value
// shorter than 127 octets
const literalOf = ([name, value]: readonly [string, string]) => {
  return Buffer.concat([
    Buffer.from([0x10, name.length]),
    Buffer.from(name, 'latin1'),
    Buffer.from([value.length]),
    Buffer.from(value, 'latin1'),
  ]);
};

/**
 * How the server under TLS on `port` ends a `POST` over HTTP/2 of the fields given, each written as
 * it is, so that a field may come in two lines where Node's client sends one, or carry what Node's
 * client refuses: the code its stream was reset with, or none when it answered.
 */
export const rawResetOverHTTP2 = (
  port: number,
  fields: readonly (readonly [string, string])[],
  { contentType = BEAD_MEDIA_TYPE, isOpen = false, path = '/bead' }: IRawRequestOptions = {}
) => {
  return new Promise<number | undefined>((resolve, reject) => {
    const socket = connectTLS({
      ALPNProtocols: ['h2'],
      ca: TLS_FIXTURE.cert,
      host,
      port,
      servername: 'localhost',
    });
    let read = Buffer.alloc(0);
    const end = (code: number | undefined) => {
      socket.destroy();
      resolve(code);
    };

    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const request = [
        [':method', 'POST'],
        [':scheme', 'https'],
        [':authority', `${host}:${String(port)}`],
        [':path', path],
        ['content-type', contentType],
        ...fields,
      ] as const;

      // its preface, its SETTINGS, then its HEADERS, END_HEADERS and optionally END_STREAM
      socket.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
      socket.write(frameOf(0x4, {}));
      socket.write(
        frameOf(0x1, {
          flags: isOpen ? 0x4 : 0x5,
          payload: Buffer.concat(request.map(literalOf)),
          stream: 1,
        })
      );
    });
    socket.on('data', (chunk: Buffer) => {
      read = Buffer.concat([read, chunk]);

      while (read.length >= 9 && read.length >= 9 + read.readUIntBE(0, 3)) {
        const length = read.readUIntBE(0, 3);
        const [type, flags] = [read.readUInt8(3), read.readUInt8(4)];
        const payload = read.subarray(9, 9 + length);

        read = read.subarray(9 + length);

        if (type === 0x4 && flags === 0) {
          socket.write(frameOf(0x4, { flags: 0x1 }));
        } else if (type === 0x3) {
          end(payload.readUInt32BE(0));
        } else if (type === 0x1 || type === 0x7) {
          end(undefined);
        }
      }
    });
  });
};

/** A client's preface and an empty SETTINGS (RFC 9113 §3.4): a session begun, no request in it. */
export const PREFACE_AND_SETTINGS = Buffer.concat([
  Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'),
  frameOf(0x4, {}),
]);

/** A PING (RFC 9113 §6.7), its 8 bytes of data zero. */
export const PING = frameOf(0x6, { payload: Buffer.alloc(8) });

/**
 * The first of a HEADERS never whole: END_STREAM without END_HEADERS, on stream 1, its one field
 * `:method: GET`, no CONTINUATION behind it.
 */
export const HEADERS_NEVER_WHOLE = frameOf(0x1, {
  flags: 0x1,
  payload: Buffer.from([0x82]),
  stream: 1,
});

/**
 * A socket under TLS to the server on `port`, offering `alpn` alone, once its handshake ended: what
 * it reads, as it comes, and whether it closed.
 */
export const tlsSocketOn = async (port: number, alpn: string) => {
  const socket: TLSSocket = connectTLS({
    ALPNProtocols: [alpn],
    ca: TLS_FIXTURE.cert,
    host,
    port,
    servername: 'localhost',
  });
  const read = { isClosed: false, text: '' };

  socket.on('data', (chunk: Buffer) => {
    read.text += chunk.toString('latin1');
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    read.isClosed = true;
  });
  await once(socket, 'secureConnect');

  return { read, socket };
};

/**
 * When each of sockets under TLS to `port` over `h2` closes, from its handshake's end, each having
 * written one of `prefixes` and nothing more: in milliseconds, or `undefined` past 5 s.
 */
export const idleEndsOverHTTP2 = async (port: number, prefixes: readonly Buffer[]) => {
  const opened = await Promise.all(
    prefixes.map(async (prefix) => {
      const { socket } = await tlsSocketOn(port, 'h2');
      const ending = closedAfter(socket);

      socket.write(prefix);

      return { ending, socket };
    })
  );

  try {
    return await Promise.all(
      opened.map(({ ending }) => {
        return ending;
      })
    );
  } finally {
    for (const { socket } of opened) {
      socket.destroy();
    }
  }
};
