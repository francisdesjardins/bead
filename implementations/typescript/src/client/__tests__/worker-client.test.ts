import { expect, test } from '@playwright/test';
import { createWorkerClient, LIMIT_DEFAULTS } from '../worker-client';

// definition

test.describe('createWorkerClient', () => {
  test('builds on a worker transport, with the limits it is given, or the defaults', () => {
    const worker = {
      postMessage: () => {},
    };
    const client = createWorkerClient({ transport: { worker } });
    const narrow = createWorkerClient({
      limits: { chunkBytes: 4_096, maximumEnvelopeBytes: 4_096 },
      transport: { worker },
    });

    expect([
      client.router.limits.maximumEnvelopeBytes,
      narrow.router.limits.maximumEnvelopeBytes,
      client.transport.isUninitialized(),
    ]).toEqual([LIMIT_DEFAULTS.maximumEnvelopeBytes, 4_096, true]);
  });
});
