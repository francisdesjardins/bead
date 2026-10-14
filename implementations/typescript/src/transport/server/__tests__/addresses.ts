import { once } from 'node:events';
import { createServer } from 'node:net';

/**
 * The addresses a server listens on, the one name it takes, and the forms it refuses (spec 15.12),
 * as the C# side's tests hold them alike: any other name, `localhost` in another case, with a final
 * dot or under it among them; the short, hexadecimal, octal, padded and one-number forms; a leading
 * zero; a final dot; brackets; a zone; an IPv4-mapped address.
 */

export const LISTENING_ADDRESSES: readonly string[] = ['127.0.0.1', '0.0.0.0', '::1', '::'];

/** `localhost`, both loopbacks, a keyword never resolved: no IP address, and taken all the same. */
export const LISTENING_NAMES: readonly string[] = ['localhost'];

export const NO_LISTENING_ADDRESSES: readonly string[] = [
  'LOCALHOST',
  'localhost.',
  'a.localhost',
  'bead.example',
  '127.1',
  '0x7f.0.0.1',
  '0177.0.0.1',
  '127.000.000.001',
  '2130706433',
  '1',
  '0',
  '1.2.3.04',
  '127.0.0.1.',
  '[::1]',
  'fe80::1%4',
  '::ffff:127.0.0.1',
];

/**
 * A socket of another process's, as it were, on the IPv6 loopback, on a port the system drew: the
 * capture a server on `localhost` leaves no room for. Disposing of it lets the port go.
 */
export const holdIPv6Loopback = async () => {
  const holder = createServer();

  holder.listen({ host: '::1', ipv6Only: true, port: 0 });
  await once(holder, 'listening');

  const address = holder.address();

  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    [Symbol.asyncDispose]: async () => {
      holder.close();
      await once(holder, 'close');
    },
  };
};

/** Whether `port` is free on `host`: a socket binds it, and lets it go. */
export const isFreeOn = async (host: string, port: number): Promise<boolean> => {
  const probe = createServer();

  probe.listen({ host, port });

  try {
    await once(probe, 'listening');
  } catch {
    return false;
  }

  probe.close();
  await once(probe, 'close');

  return true;
};

/** An error a bind fails with, its `code` as Node gives it. */
export const bindError = (code: string): Error => {
  return Object.assign(new Error(`listen ${code}`), { code });
};
