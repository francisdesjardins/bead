import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';

import { fetchPinned } from '../fetch-pinned.mjs';

const BYTES = Buffer.from('bead');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const INTEGRITY = `sha512-${createHash('sha512').update(BYTES).digest('base64')}`;

// ── A server ──────────────────────────────────────────────────────────────────

// a server on the loopback whose nth request plays the nth step, the last one played past them
const serve = async (steps) => {
  let requests = 0;
  const server = createServer((request, response) => {
    const step = steps[Math.min(requests, steps.length - 1)];

    requests += 1;

    if (typeof step === 'function') {
      step(request, response);
      return;
    }

    if (step === 'drop') {
      request.socket.destroy();
      return;
    }

    response.writeHead(step.status, step.headers ?? {});
    response.end(step.body ?? '');
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${String(server.address().port)}/file`,
    requests: () => {
      return requests;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
};

// the pauses asked for, recorded and never waited
const recorder = () => {
  const pauses = [];

  return {
    pauses,
    pause: async (ms) => {
      pauses.push(ms);
    },
  };
};

const OK = Object.freeze({ status: 200, body: BYTES });
// the policy: four tries, the pause doubling from 2 s, 60 s at most
const TRIES = 4;
const FIRST_PAUSE = 2_000;
const LONGEST_PAUSE = 60_000;

// ── The download ──────────────────────────────────────────────────────────────

describe('a pinned download', () => {
  test('a 503 is tried again after the first pause, and the 200 after it returns the bytes', async () => {
    const server = await serve([{ status: 503 }, OK]);
    const { pauses, pause } = recorder();

    try {
      assert.deepEqual(await fetchPinned(server.url, SHA256, { pause }), BYTES);
      assert.equal(server.requests(), 2);
      assert.deepEqual(pauses, [FIRST_PAUSE]);
    } finally {
      await server.close();
    }
  });

  test('a 429 waits what its Retry-After asks, in seconds or as a date, within the longest pause', async () => {
    const server = await serve([
      { status: 429, headers: { 'Retry-After': '7' } },
      { status: 429, headers: { 'Retry-After': '600' } },
      { status: 503, headers: { 'Retry-After': new Date(0).toUTCString() } },
      OK,
    ]);
    const { pauses, pause } = recorder();

    try {
      assert.deepEqual(await fetchPinned(server.url, SHA256, { pause }), BYTES);
      assert.equal(server.requests(), 4);
      assert.deepEqual(pauses, [7_000, LONGEST_PAUSE, 0]);
    } finally {
      await server.close();
    }
  });

  test('a 404 is refused at once, by its URL and its status', async () => {
    const server = await serve([{ status: 404 }, OK]);
    const { pauses, pause } = recorder();

    try {
      await assert.rejects(fetchPinned(server.url, SHA256, { pause }), {
        message: `${server.url}: 404 Not Found`,
      });
      assert.equal(server.requests(), 1);
      assert.deepEqual(pauses, []);
    } finally {
      await server.close();
    }
  });

  test('a connection dropped before its answer is tried again', async () => {
    const server = await serve(['drop', OK]);
    const { pauses, pause } = recorder();

    try {
      assert.deepEqual(await fetchPinned(server.url, SHA256, { pause }), BYTES);
      assert.equal(server.requests(), 2);
      assert.deepEqual(pauses, [FIRST_PAUSE]);
    } finally {
      await server.close();
    }
  });

  test('a server that never answers spends four bounded tries, with no real timeout wait', async () => {
    const bounds = [];
    const signals = [];
    let controller;
    const timeoutSignal = (ms) => {
      bounds.push(ms);
      controller = new AbortController();
      signals.push(controller.signal);

      return controller.signal;
    };
    const server = await serve([
      () => {
        controller.abort(new DOMException('download try timed out', 'TimeoutError'));
      },
    ]);
    const { pauses, pause } = recorder();

    try {
      await assert.rejects(fetchPinned(server.url, SHA256, { pause, timeoutSignal }), {
        message: `${server.url}: download try timed out, after 4 tries`,
      });
      assert.equal(server.requests(), TRIES);
      assert.deepEqual(bounds, [60_000, 60_000, 60_000, 60_000]);
      assert.equal(new Set(signals).size, TRIES);
      assert.ok(
        signals.every((signal) => {
          return signal.aborted;
        })
      );
      assert.deepEqual(pauses, [FIRST_PAUSE, FIRST_PAUSE * 2, FIRST_PAUSE * 4]);
    } finally {
      await server.close();
    }
  });

  test('a timed-out try gives the next try its own configured bound and checks its pin', async () => {
    const bounds = [];
    const signals = [];
    let controller;
    const timeoutSignal = (ms) => {
      bounds.push(ms);
      controller = new AbortController();
      signals.push(controller.signal);

      return controller.signal;
    };
    const server = await serve([
      () => {
        controller.abort(new DOMException('download try timed out', 'TimeoutError'));
      },
      OK,
    ]);
    const { pauses, pause } = recorder();

    try {
      assert.deepEqual(
        await fetchPinned(server.url, SHA256, { pause, timeout: 123, timeoutSignal }),
        BYTES
      );
      assert.deepEqual(bounds, [123, 123]);
      assert.notEqual(signals[0], signals[1]);
      assert.equal(signals[1].aborted, false);
      assert.equal(server.requests(), 2);
      assert.deepEqual(pauses, [FIRST_PAUSE]);
    } finally {
      await server.close();
    }
  });

  test('a timeout outside the timer’s range is refused before a request', async () => {
    const server = await serve([OK]);

    try {
      for (const timeout of [0, -1, 0.5, NaN, Infinity, 2 ** 31, 2 ** 32, '1000']) {
        await assert.rejects(fetchPinned(server.url, SHA256, { timeout }), /a try's timeout is/u);
      }

      assert.equal(server.requests(), 0);
    } finally {
      await server.close();
    }
  });

  test('a timeout while its body is read retries the whole file, under a fresh bound', async (context) => {
    const nativeFetch = globalThis.fetch;
    let controller;
    let answers = 0;

    context.mock.method(globalThis, 'fetch', async (url, options) => {
      const response = await nativeFetch(url, options);

      answers += 1;

      if (answers === 1) {
        const read = response.arrayBuffer.bind(response);

        context.mock.method(response, 'arrayBuffer', () => {
          controller.abort(new DOMException('download body timed out', 'TimeoutError'));

          return read();
        });
      }

      return response;
    });

    const server = await serve([
      (_request, response) => {
        response.writeHead(200, { 'Content-Length': '4' });
        response.write('b');
      },
      OK,
    ]);
    const { pauses, pause } = recorder();
    const signals = [];
    const timeoutSignal = () => {
      controller = new AbortController();
      signals.push(controller.signal);

      return controller.signal;
    };

    try {
      assert.deepEqual(await fetchPinned(server.url, SHA256, { pause, timeoutSignal }), BYTES);
      assert.equal(answers, 2);
      assert.equal(server.requests(), 2);
      assert.deepEqual(pauses, [FIRST_PAUSE]);
      assert.equal(signals[0].aborted, true);
      assert.equal(signals[1].aborted, false);
    } finally {
      await server.close();
    }
  });

  test('bytes off the sha256 are refused, never tried again', async () => {
    const server = await serve([{ status: 200, body: 'not bead' }, OK]);
    const { pauses, pause } = recorder();
    const actual = createHash('sha256').update('not bead').digest('hex');

    try {
      await assert.rejects(fetchPinned(server.url, SHA256, { pause }), {
        message: `${server.url}: sha256 ${actual}, where the pin says sha256 ${SHA256}`,
      });
      assert.equal(server.requests(), 1);
      assert.deepEqual(pauses, []);
    } finally {
      await server.close();
    }
  });

  test("an integrity as npm's dist.integrity writes it is held as a sha256 is", async () => {
    const server = await serve([OK]);
    const { pause } = recorder();
    const other = `sha512-${createHash('sha512').update('not bead').digest('base64')}`;

    try {
      assert.deepEqual(await fetchPinned(server.url, INTEGRITY, { pause }), BYTES);
      await assert.rejects(fetchPinned(server.url, other, { pause }), {
        message: `${server.url}: ${INTEGRITY}, where the pin says ${other}`,
      });
      assert.equal(server.requests(), 2);
    } finally {
      await server.close();
    }
  });

  test('tries spent name the URL, the last status and how many tries were made', async () => {
    const server = await serve([{ status: 503 }]);
    const { pauses, pause } = recorder();

    try {
      await assert.rejects(fetchPinned(server.url, SHA256, { pause }), {
        message: `${server.url}: 503 Service Unavailable, after ${String(TRIES)} tries`,
      });
      assert.equal(server.requests(), TRIES);
      assert.deepEqual(pauses, [FIRST_PAUSE, FIRST_PAUSE * 2, FIRST_PAUSE * 4]);
    } finally {
      await server.close();
    }
  });

  test('a pin of no form it knows is refused before a request', async () => {
    const server = await serve([OK]);

    try {
      for (const pin of [
        undefined,
        SHA256.toUpperCase(),
        'md5-x',
        `sha256-${INTEGRITY.slice(7)}`,
      ]) {
        await assert.rejects(fetchPinned(server.url, pin), /its pin is no sha256/u);
      }

      assert.equal(server.requests(), 0);
    } finally {
      await server.close();
    }
  });
});
