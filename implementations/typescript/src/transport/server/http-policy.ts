// ── HTTP policy ───────────────────────────────────────────────────────────────

// One object of what an HTTP server judges a request by first (spec 15.12, decision 0037): its
// hosts, origins, proxies and bounds, checked once and given alike to the HTTP transport and a
// gateway, so two listeners never keep two lists alike in silence.

// dependencies

import { assertHeldFinite } from '../shared/clock';
import { ProgrammerError } from '../shared/errors';
import { assertHosts, assertOrigins } from './hosts-and-origins';
import { assertCount } from './server-bounds';
import { assertTrustedProxies, assertUnnamedProxies } from './trusted-proxies';

// interfaces

/**
 * What an HTTP policy is made of, each member as the HTTP transport's option of its name takes it
 * and its default where none is given (spec 15.12).
 */
export interface IHTTPPolicyInit {
  readonly bodyBytesBudget?: number | undefined;
  readonly bodyGracePeriod?: number | undefined;
  readonly headersTimeout?: number | undefined;
  readonly hosts?: readonly string[] | undefined;
  readonly maximumBodyBytes?: number | undefined;
  readonly maximumConnections?: number | undefined;
  readonly maximumConnectionsPerAddress?: number | undefined;
  readonly minimumBodyBytesPerSecond?: number | undefined;
  readonly minimumSendBytesPerSecond?: number | undefined;
  readonly origins?: readonly string[] | undefined;
  readonly sendGracePeriod?: number | undefined;
  readonly trustedProxies?: readonly string[] | undefined;
  readonly unnamedProxies?: number | undefined;
}

/** An HTTP policy, checked as it was built and frozen: what {@link httpPolicyOf} gives. */
export interface IHTTPPolicy extends IHTTPPolicyInit {
  readonly [POLICY]: true;
}

/** What an option object takes beside its members: a policy of them, which it gives none of twice. */
export interface IHTTPPolicyOption {
  readonly policy?: IHTTPPolicy | undefined;
}

// constants

/** What marks a policy built by {@link httpPolicyOf}, never by hand. */
const POLICY: unique symbol = Symbol('bead.httpPolicy');

/** A policy's members, by their names. */
export const HTTP_POLICY_MEMBERS = Object.freeze([
  'bodyBytesBudget',
  'bodyGracePeriod',
  'headersTimeout',
  'hosts',
  'maximumBodyBytes',
  'maximumConnections',
  'maximumConnectionsPerAddress',
  'minimumBodyBytesPerSecond',
  'minimumSendBytesPerSecond',
  'origins',
  'sendGracePeriod',
  'trustedProxies',
  'unnamedProxies',
] as const satisfies readonly (keyof IHTTPPolicyInit)[]);

// the counts above 0, the rates from 0, and the durations of section 1.4, finite
const COUNTS = Object.freeze([
  'bodyBytesBudget',
  'maximumBodyBytes',
  'maximumConnections',
  'maximumConnectionsPerAddress',
] as const);
const RATES = Object.freeze(['minimumBodyBytesPerSecond', 'minimumSendBytesPerSecond'] as const);
const DURATIONS = Object.freeze(['bodyGracePeriod', 'headersTimeout', 'sendGracePeriod'] as const);

// definition

/**
 * A policy of `init`'s members, checked once as each listener would check it — its hosts and
 * origins by their forms, its proxies by theirs, each count, rate and duration by its bound — and
 * frozen, its lists copied: what does not hold is a {@link ProgrammerError}. Given as `policy` to
 * the HTTP transport's options and to a gateway's, each takes its members from it.
 *
 * @example
 * import { httpPolicyOf } from '@francisdesjardins/bead/http-transport-server';
 *
 * const policy = httpPolicyOf({ hosts: ['api.example'], origins: ['https://app.example'] });
 * const transport = createHTTPTransportServer({ createServer, policy });
 * const gateway = createHTTPGateway({ policy, routes: HTTP_ROUTES, transport: memory });
 */
export const httpPolicyOf = (init: IHTTPPolicyInit = {}): IHTTPPolicy => {
  const { hosts, origins, trustedProxies, unnamedProxies } = init;

  assertHosts(hosts);
  assertOrigins(origins);
  assertTrustedProxies(trustedProxies);
  assertUnnamedProxies(unnamedProxies);

  for (const name of COUNTS) {
    if (init[name] !== undefined) {
      assertCount(name, { value: init[name] });
    }
  }

  for (const name of RATES) {
    if (init[name] !== undefined) {
      assertCount(name, { mayBeNone: true, value: init[name] });
    }
  }

  for (const name of DURATIONS) {
    if (init[name] !== undefined) {
      assertHeldFinite(name, init[name]);
    }
  }

  const members: Record<string, unknown> = {};

  for (const name of HTTP_POLICY_MEMBERS) {
    const value = init[name];

    if (value !== undefined) {
      members[name] = Array.isArray(value) ? Object.freeze([...(value as unknown[])]) : value;
    }
  }

  return Object.freeze({ ...members, [POLICY]: true }) as IHTTPPolicy;
};

/**
 * `options` with its policy's members in place of its `policy`: a policy not built by
 * {@link httpPolicyOf}, or a member given both in the policy and beside it, is a
 * {@link ProgrammerError}, so that a listener never takes one value of two in silence.
 */
export const withPolicy = <Options extends IHTTPPolicyOption>(
  options: Options
): Omit<Options, 'policy'> => {
  const { policy, ...members } = options;

  if (policy === undefined) {
    return members;
  }

  if ((policy as Partial<IHTTPPolicy>)[POLICY] !== true) {
    throw new ProgrammerError('a policy is what httpPolicyOf builds');
  }

  for (const name of HTTP_POLICY_MEMBERS) {
    if (policy[name] !== undefined && (members as Record<string, unknown>)[name] !== undefined) {
      throw new ProgrammerError(`${name} is given in the policy and beside it: give it once`);
    }
  }

  const taken: Record<string, unknown> = {};

  for (const name of HTTP_POLICY_MEMBERS) {
    if (policy[name] !== undefined) {
      taken[name] = policy[name];
    }
  }

  return { ...members, ...taken };
};
