import { createServer as createNodeServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../shared/errors';
import { HTTP_POLICY_MEMBERS, httpPolicyOf, withPolicy } from '../http-policy';
import { createHTTPTransportServer } from '../http-transport-server';

// tests

test('builds a policy of its members, checked once and frozen, and refuses one that does not hold', () => {
  const hosts = ['api.example'];
  const policy = httpPolicyOf({
    bodyGracePeriod: 1_000,
    hosts,
    maximumConnectionsPerAddress: 8,
    minimumSendBytesPerSecond: 0,
    origins: ['https://app.example'],
    trustedProxies: ['10.0.0.1'],
    unnamedProxies: 1,
  });

  hosts.push('evil.example');
  expect(policy.hosts).toEqual(['api.example']);
  expect(Object.isFrozen(policy)).toBe(true);
  expect(Object.isFrozen(policy.hosts)).toBe(true);
  expect(policy.maximumBodyBytes).toBeUndefined();
  expect(HTTP_POLICY_MEMBERS).toContain('origins');

  for (const init of [
    { hosts: ['https://api.example'] },
    { origins: ['app.example'] },
    { trustedProxies: ['not an address'] },
    { unnamedProxies: 9 },
    { maximumBodyBytes: 0 },
    { minimumBodyBytesPerSecond: -1 },
    { headersTimeout: Number.POSITIVE_INFINITY },
  ]) {
    expect(() => {
      return httpPolicyOf(init);
    }, JSON.stringify(init)).toThrow(ProgrammerError);
  }
});

test('gives a listener its members from its policy, and refuses one given in it and beside it', () => {
  const policy = httpPolicyOf({ hosts: ['api.example'], maximumBodyBytes: 1_024 });

  expect(withPolicy({ pathname: '/bead', policy })).toEqual({
    hosts: ['api.example'],
    maximumBodyBytes: 1_024,
    pathname: '/bead',
  });
  expect(withPolicy({ origins: ['https://app.example'], policy: undefined })).toEqual({
    origins: ['https://app.example'],
  });
  expect(() => {
    return withPolicy({ hosts: ['other.example'], policy });
  }).toThrow('hosts is given in the policy and beside it: give it once');

  // a member given beside its policy is given, at its default as at any other value
  const proxied = httpPolicyOf({ unnamedProxies: 1 });

  expect(withPolicy({ policy: proxied })).toEqual({ unnamedProxies: 1 });
  expect(() => {
    return withPolicy({ policy: proxied, unnamedProxies: 0 });
  }).toThrow('unnamedProxies is given in the policy and beside it: give it once');

  // a list written as none is none given
  const hosted = httpPolicyOf({ hosts: ['api.example'] });

  expect(withPolicy({ policy: hosted, hosts: undefined }).hosts).toEqual(['api.example']);
  expect(() => {
    return withPolicy({ policy: { hosts: [] } as unknown as ReturnType<typeof httpPolicyOf> });
  }).toThrow('a policy is what httpPolicyOf builds');

  // the HTTP transport takes one, as a gateway does
  expect(
    createHTTPTransportServer({
      createServer: (listener) => {
        return createNodeServer(listener);
      },
      policy,
    }).type
  ).toBe('HTTP');
  expect(() => {
    return createHTTPTransportServer({
      createServer: (listener) => {
        return createNodeServer(listener);
      },
      maximumBodyBytes: 2_048,
      policy,
    });
  }).toThrow(ProgrammerError);
});
