// ── Fuzz target: the HTTP transport's field parsers ───────────────────────────

// Raw bytes as a request's field, read as the HTTP transport's server reads its fields. The first
// byte picks the field, modulo the five below; the others are its value, one character an octet, as
// Node hands a field's octets on in Latin-1, each line feed parting two of its lines. No parser here
// refuses by throwing: each returns, and any error is a finding. The C# side's `HttpFieldsTarget` is
// its twin, slot for slot, with the same server around it.

// dependencies

import { parseItem } from '../../src/transport/shared/structured-fields';
import {
  authorityOf,
  credentialOf,
  hostPartOf,
  isAuthority,
  isListedOrigin,
  isTakenHost,
  isTakenOrigin,
  isVisibleField,
  isWellFormedHost,
  originOf,
  ownAuthorityOf,
  requestTargetOf,
} from '../../src/transport/server/hosts-and-origins';
import {
  addressOfEntry,
  clientAddressOf,
  trustedProxiesOf,
} from '../../src/transport/server/trusted-proxies';

// constants

// the server the fields come to: its socket's peer, a proxy it names, and what it takes
const REMOTE_ADDRESS = '10.0.0.1';
const TRUSTED_PROXIES = trustedProxiesOf(['10.0.0.0/8', '2001:db8::/32'], { unnamedProxies: 2 });
const HOSTS = Object.freeze(['example.test']);
const OWN_AUTHORITY = 'localhost:8080';
const ORIGINS = Object.freeze(['https://app.example.test']);

// the fields, by the first byte's slot
const SLOTS = Object.freeze({
  // `bead-after`, `bead-wait` and `bead-listen`: an Item of RFC 9651, a count or a Boolean
  ITEM: 0,
  AUTHORIZATION: 1,
  FORWARDED_FOR: 2,
  // the request's target, its first line, then its `Host`'s lines
  HOST: 3,
  ORIGIN: 4,
});
const SLOT_COUNT = 5;

// helpers

const readForwardedFor = (value: string): void => {
  for (const entry of value.split(',')) {
    addressOfEntry(entry);
  }

  clientAddressOf(REMOTE_ADDRESS, { forwarded: value, trustedProxies: TRUSTED_PROXIES });
};

const readHost = ([line, ...hostLines]: readonly string[]): void => {
  const target = requestTargetOf(line);

  isWellFormedHost(hostLines, { isRequired: true });

  const authority = authorityOf(hostLines, { isRequired: true, target })?.authority;

  for (const named of [authority, target?.authority, hostLines[0]]) {
    if (named !== undefined) {
      isAuthority(named);
      hostPartOf(named);
      isTakenHost(named, HOSTS);
      ownAuthorityOf(named, HOSTS);
    }
  }
};

const readOrigin = (lines: readonly string[]): void => {
  const origin = originOf(lines);

  isTakenOrigin(origin, { host: OWN_AUTHORITY, origins: ORIGINS });
  isListedOrigin(origin, ORIGINS);
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const value = Buffer.from(data.subarray(1)).toString('latin1');
  const lines = value.split('\n');

  for (const line of lines) {
    isVisibleField(line);
  }

  switch ((data[0] ?? 0) % SLOT_COUNT) {
    case SLOTS.ITEM:
      parseItem(value);
      break;
    case SLOTS.AUTHORIZATION:
      credentialOf(lines);
      break;
    case SLOTS.FORWARDED_FOR:
      readForwardedFor(value);
      break;
    case SLOTS.HOST:
      readHost(lines);
      break;
    // SLOTS.ORIGIN
    default:
      readOrigin(lines);
  }
};
