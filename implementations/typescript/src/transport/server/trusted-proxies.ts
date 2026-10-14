// ── Trusted proxies ───────────────────────────────────────────────────────────

// dependencies

import { BlockList, isIPv6 } from 'node:net';
import { ProgrammerError } from '../shared/errors';
import { isIPAddress, isIPv4Address } from './hosts-and-origins';

// types

/**
 * The proxies a server trusts: those it names, one `BlockList` a family — a network holds the
 * addresses of its own family alone, where one `BlockList` would match an IPv4 address against an
 * IPv6 network by its mapped form — and how many it counts that none of them holds.
 */
export interface ITrustedProxies {
  readonly ipv4: BlockList;
  readonly ipv6: BlockList;
  /** The proxies on every path to the server that the lists do not hold, `unnamedProxies`. */
  readonly unnamed: number;
}

// constants

/**
 * The most proxies a server counts that `trustedProxies` does not name (spec 15.12): past any path a
 * platform documents, a tripwire against the count of every hop.
 */
export const MAXIMUM_UNNAMED_PROXIES = 8;

// a network: an address, `/`, and its prefix's length, with no leading zero (RFC 4632 §3.1, RFC 4291
// §2.3)
const NETWORK = /^(?<address>[^/]*)\/(?<prefix>0|[1-9]\d*)$/u;

// an IPv4 address followed by `:` and a port, as RFC 7239 §6 writes a node unquoted
const IPV4_WITH_PORT = /^(?<address>[^:]*):\d{1,5}$/u;

// an IPv6 address in brackets, followed or not by `:` and a port, as RFC 7239 §6 writes a node
const IPV6_IN_BRACKETS = /^\[(?<address>[^\]]*)\](?::\d{1,5})?$/u;

// an IPv4-mapped address as the URL Standard serializes it, its IPv4 address in two hexadecimal
// pieces (RFC 4291 §2.5.5.2)
const IPV4_MAPPED_PIECES = /^::ffff:(?<high>[\da-f]{1,4}):(?<low>[\da-f]{1,4})$/u;

// the bits of each family's address
const IPV4_BITS = 32;
const IPV6_BITS = 128;

// helpers

// a field entry without the spaces and tabs around it (RFC 9110 §5.6.3)
const trimmed = (value: string): string => {
  return value.replaceAll(/^[\t ]+|[\t ]+$/gu, '');
};

// an IPv6 address in the text RFC 5952 §4 recommends, lower case and compressed, hexadecimal
// throughout, as the URL Standard serializes it — the deprecated IPv4-compatible form among them,
// which a platform may write dotted; none for one the URL Standard does not take, a zone among them
const ipv6TextOf = (address: string): string | undefined => {
  return URL.parse(`http://[${address}]/`)?.hostname.slice(1, -1);
};

// the 32 bits of an IPv4 address, as a number
const ipv4BitsOf = (address: string): bigint => {
  return address.split('.').reduce((bits, octet) => {
    return (bits << 8n) | BigInt(octet);
  }, 0n);
};

// the 128 bits of an IPv6 address, from its RFC 5952 text, whose `::` stands for the zero pieces
// it leaves out
const ipv6BitsOf = (text: string): bigint => {
  const [head = '', tail] = text.split('::');
  const headPieces = head === '' ? [] : head.split(':');
  const tailPieces = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = Array.from({ length: 8 - headPieces.length - tailPieces.length }, () => {
    return '0';
  });

  return [...headPieces, ...(tail === undefined ? [] : zeros), ...tailPieces].reduce(
    (bits, piece) => {
      return (bits << 16n) | BigInt(`0x${piece}`);
    },
    0n
  );
};

// an address written back from its bits: dotted for IPv4, RFC 5952's text for IPv6
const textOfBits = (bits: bigint, width: number): string => {
  if (width === IPV4_BITS) {
    return [24n, 16n, 8n, 0n]
      .map((shift) => {
        return String((bits >> shift) & 0xffn);
      })
      .join('.');
  }

  const pieces = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) => {
    return ((bits >> shift) & 0xffffn).toString(16);
  });

  return ipv6TextOf(pieces.join(':')) ?? pieces.join(':');
};

// the family `BlockList` checks an address of the one form under
const familyOf = (address: string): 'ipv4' | 'ipv6' => {
  return isIPv4Address(address) ? 'ipv4' : 'ipv6';
};

// definition

/**
 * An address in the one form a server holds it in (spec 15.12), for its bound, its handle and its
 * refusals: an IPv4 address as written; an IPv4-mapped IPv6 address as that IPv4 address (RFC 4291
 * §2.5.5.2), in any of its forms; any other IPv6 address in the text RFC 5952 §4 recommends,
 * hexadecimal throughout, its zone, a link-local socket's, left out. One that is no address stays as
 * it came.
 */
export const heldAddressOf = (address: string): string => {
  if (isIPv4Address(address) || !isIPv6(address)) {
    return address;
  }

  const text = ipv6TextOf(address.replace(/%.*$/su, ''));

  if (text === undefined) {
    return address;
  }

  const { high, low } = IPV4_MAPPED_PIECES.exec(text)?.groups ?? {};

  return high === undefined || low === undefined
    ? text
    : textOfBits((BigInt(`0x${high}`) << 16n) | BigInt(`0x${low}`), IPV4_BITS);
};

/**
 * The address an `X-Forwarded-For` entry names (spec 15.12), in {@link heldAddressOf}'s form, once
 * the spaces and tabs around it are removed: one of RFC 7239 §6's node forms, unquoted and not
 * obfuscated — a bare IPv4 address, or one followed by `:` and a port; a bare IPv6 address without
 * a zone, or one in brackets, followed or not by `:` and a port — its port dropped. None for any
 * other, a zone, a name, `unknown` and an empty entry among them.
 */
export const addressOfEntry = (entry: string): string | undefined => {
  const value = trimmed(entry);

  if (isIPv4Address(value)) {
    return value;
  }

  const withPort = IPV4_WITH_PORT.exec(value)?.groups?.['address'];

  if (withPort !== undefined && isIPv4Address(withPort)) {
    return withPort;
  }

  // an IPv6 address in its brackets, or bare; never with a zone, which names an interface of the
  // proxy's own
  const address = IPV6_IN_BRACKETS.exec(value)?.groups?.['address'] ?? value;

  return address.includes('%') || !isIPv6(address) ? undefined : heldAddressOf(address);
};

/**
 * Refuses, with a {@link ProgrammerError} naming the entry, a `trustedProxies` entry that is neither
 * an IP address in the form a server listens on — bare, with no zone, not IPv4-mapped — nor a
 * network, that address followed by `/` and its prefix's length (RFC 4632 §3.1, RFC 4291 §2.3), from
 * 1 to its family's bits, its bits past the prefix zero: a name, which another host resolves
 * otherwise, among them. A network of prefix 0 is refused besides: it would trust what every client
 * writes.
 */
export const assertTrustedProxies = (entries: readonly string[] | undefined): void => {
  for (const entry of entries ?? []) {
    const { address = entry, prefix } = NETWORK.exec(entry)?.groups ?? {};

    if (!isIPAddress(address)) {
      throw new ProgrammerError(
        `a trustedProxies entry is an IP address, bare, or a network, address/prefix: not ${entry}`
      );
    }

    if (prefix === undefined) {
      continue;
    }

    const width = isIPv4Address(address) ? IPV4_BITS : IPV6_BITS;
    const length = Number(prefix);

    if (length === 0) {
      throw new ProgrammerError(
        'trustedProxies does not take a network of prefix 0: it would trust what every client writes'
      );
    }

    if (length > width) {
      throw new ProgrammerError(
        `a trustedProxies network's prefix is ${String(width)} bits at most: not ${entry}`
      );
    }

    const bits = width === IPV4_BITS ? ipv4BitsOf(address) : ipv6BitsOf(ipv6TextOf(address) ?? '');
    const past = (1n << BigInt(width - length)) - 1n;

    if ((bits & past) !== 0n) {
      throw new ProgrammerError(
        `a trustedProxies network has no bits set past its prefix: write ${textOfBits(bits & ~past, width)}/${prefix}, not ${entry}`
      );
    }
  }
};

/**
 * Refuses, with a {@link ProgrammerError} naming it, an `unnamedProxies` that is not a whole number
 * from 0 to {@link MAXIMUM_UNNAMED_PROXIES}: a fraction, `NaN`, and `Infinity`, the count of every
 * hop, which would trust what every client writes, among them.
 */
export const assertUnnamedProxies = (count: number | undefined): void => {
  if (count === Infinity) {
    throw new ProgrammerError(
      'unnamedProxies is a whole number of proxies from 0 to 8, those trustedProxies does not name, not Infinity: it would trust what every client writes'
    );
  }

  if (
    count !== undefined &&
    (!Number.isInteger(count) || count < 0 || count > MAXIMUM_UNNAMED_PROXIES)
  ) {
    throw new ProgrammerError(
      `unnamedProxies is a whole number of proxies from 0 to 8, those trustedProxies does not name: not ${String(count)}`
    );
  }
};

/**
 * The proxies a server trusts, from `entries` once {@link assertTrustedProxies} took them — their
 * addresses and networks, each family's apart, which {@link clientAddressOf} checks an address of
 * the one form against — and `unnamedProxies` once {@link assertUnnamedProxies} took it, 0 when not
 * given. None trusts no proxy, the loopback among them.
 */
export const trustedProxiesOf = (
  entries: readonly string[] | undefined,
  options?: { unnamedProxies?: number | undefined }
): ITrustedProxies => {
  const { unnamedProxies = 0 } = options ?? {};

  assertTrustedProxies(entries);
  assertUnnamedProxies(unnamedProxies);

  const proxies: ITrustedProxies = Object.freeze({
    ipv4: new BlockList(),
    ipv6: new BlockList(),
    unnamed: unnamedProxies,
  });

  for (const entry of entries ?? []) {
    const { address = entry, prefix } = NETWORK.exec(entry)?.groups ?? {};
    const held = heldAddressOf(address);
    const family = familyOf(held);

    if (prefix === undefined) {
      proxies[family].addAddress(held, family);
    } else {
      proxies[family].addSubnet(held, Number(prefix), family);
    }
  }

  return proxies;
};

/**
 * A client's address (spec 15.12): its socket's, `remoteAddress`, in {@link heldAddressOf}'s form;
 * then, while the address reached is one `trustedProxies` names, or one it does not while fewer than
 * its `unnamed` such addresses were passed, which then counts it, the next entry of `forwarded`, an
 * `X-Forwarded-For`'s lines joined, read from the right, while it is an address
 * ({@link addressOfEntry}): an entry that is none, or the field's end, ends the walk where it is. A
 * named proxy costs none of the count, wherever it stands. A client cannot move it: what it wrote
 * left of the first address past the count that no proxy named holds is never read.
 */
export const clientAddressOf = (
  remoteAddress: string,
  options?: { forwarded?: string | undefined; trustedProxies?: ITrustedProxies | undefined }
): string => {
  const { forwarded, trustedProxies } = options ?? {};
  const entries = forwarded === undefined ? [] : forwarded.split(',');
  let client = heldAddressOf(remoteAddress);
  let unnamed = trustedProxies?.unnamed ?? 0;

  const isNamed = (address: string): boolean => {
    const family = familyOf(address);

    return (
      trustedProxies !== undefined &&
      (isIPv4Address(address) || isIPv6(address)) &&
      trustedProxies[family].check(address, family)
    );
  };

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    // * an address no proxy named holds spends one of the count, and ends the walk past it
    if (!isNamed(client)) {
      if (unnamed === 0) {
        break;
      }

      unnamed -= 1;
    }

    const next = addressOfEntry(entries[index] ?? '');

    if (next === undefined) {
      break;
    }

    client = next;
  }

  return client;
};
