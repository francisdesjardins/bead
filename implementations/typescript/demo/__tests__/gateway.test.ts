import { createServer as createNodeServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { createMetricsRegistry } from '../../src/router/shared/metrics-registry';
import { createServer } from '../../src/server/server';
import { createHTTPGateway } from '../../src/transcoding/http-gateway';
import { createMemoryTransportServer } from '../../src/transport/server/memory-transport-server';
import { HTTP_PROBLEM_TYPES, HTTP_ROUTES, OPENAPI_DOCUMENT } from '../gen/typescript/bead_http';
import { offer } from '../offer';

// helpers

/**
 * The demo's procedures offered on a server over the in-memory transport, and the gateway of the
 * sign-up's routes in front of it, mounted on a Node server of its own as `server.ts` mounts it on
 * the public port, on 127.0.0.1.
 */
const mounted = async () => {
  const transport = createMemoryTransportServer();
  const server = createServer({ transport });
  const gateway = createHTTPGateway({
    document: OPENAPI_DOCUMENT,
    problemTypes: HTTP_PROBLEM_TYPES,
    routes: HTTP_ROUTES,
    transport,
  });
  const pages = createNodeServer((request, response) => {
    if (!gateway.listener(request, response)) {
      response.writeHead(404);
      response.end();
    }
  });

  offer(server, createMetricsRegistry());
  await transport.start();
  await new Promise<void>((resolve) => {
    pages.listen(0, '127.0.0.1', resolve);
  });

  const { port } = pages.address() as { port: number };

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    [Symbol.asyncDispose]: async () => {
      await gateway[Symbol.asyncDispose]();
      await new Promise((resolve) => {
        pages.close(resolve);
      });
      await transport.stop();
    },
  };
};

/** A sign-up posted to its default route, as `curl` posts it. */
const signUp = (origin: string, body: unknown) => {
  return fetch(`${origin}/api/SignUp/signUp`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
};

// definition

test.describe("the demo's gateway", () => {
  test('answers a sign-up its rules take with its welcome, in JSON', async () => {
    await using demo = await mounted();
    const answer = await signUp(demo.origin, {
      email: 'ada@example.org',
      name: 'ada',
      seats: 2,
    });

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/json');
    expect(await answer.json()).toEqual({
      welcome: 'welcome, ada: 2 seats held, confirmed by email to ada@example.org',
    });
  });

  test('answers a sign-up its rules refuse 422, each violation an error placed by its pointer (RFC 9457)', async () => {
    await using demo = await mounted();
    const answer = await signUp(demo.origin, {
      email: 'ada@example',
      name: '9 Lives!',
      phone: '555-0100',
      seats: 12,
    });
    const problem = (await answer.json()) as {
      errors: { pointer: string; ruleId: string }[];
      status: number;
      title: string;
    };

    expect(answer.status).toBe(422);
    expect(answer.headers.get('content-type')).toBe('application/problem+json');
    expect({ status: problem.status, title: problem.title }).toEqual({
      status: 422,
      title: 'PAYLOAD_INVALID',
    });
    expect(
      problem.errors.map(({ pointer, ruleId }) => {
        return [pointer, ruleId];
      })
    ).toEqual([
      ['#/name', 'string.pattern'],
      ['#/seats', 'int32.gte_lte'],
      ['#/email', 'string.pattern'],
      ['#/phone', 'string.pattern'],
      ['#', 'message.oneof'],
    ]);
  });

  test('serves the OpenAPI document beadc wrote of the sign-up, byte for byte', async () => {
    await using demo = await mounted();
    const answer = await fetch(`${demo.origin}/openapi.json`);

    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(OPENAPI_DOCUMENT);
  });
});
