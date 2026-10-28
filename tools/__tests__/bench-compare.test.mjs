import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { test } from 'node:test';

import {
  compare,
  thresholdsOf,
  validate,
  mannWhitney,
  hodgesLehmann,
  smallestDetectableChange,
} from '../bench-compare.mjs';

const report = (values = [100, 90, 110], options = {}) => {
  const sorted = values.toSorted((a, b) => {
    return a - b;
  });

  const name = options.name ?? 'call.p50';

  const unit = options.unit ?? 'us';

  return {
    schema: 'bead-bench/1',

    side: options.side ?? 'typescript',

    environment: {
      cpu: { model: 'test CPU', count: 4 },

      os: { platform: 'test', release: '1', architecture: 'x64' },

      runtimes: { node: '24.9.0', v8: 'test', dotnet: '10.0' },

      commit: 'a'.repeat(40),
    },

    method: {
      runs: values.length,

      seconds: 3,

      concurrency: 32,

      notificationIntervalMs: 1,

      notificationWindow: 32,

      memoryCalls: 2000,

      memory: { method: 'test', scope: 'process', limitations: 'test only' },

      transfer: 'whole or chunked',

      interop: 'calls',
    },

    measures: [
      {
        id: `local.http.0.${name}`,

        name,

        scenario: 'local',

        transport: 'http',

        sizeBytes: 0,

        unit,

        direction: unit.endsWith('/s') ? 'higher' : 'lower',

        samples: values,

        median:
          values.length % 2
            ? sorted[Math.floor(values.length / 2)]
            : (sorted[values.length / 2 - 1] + sorted[values.length / 2]) / 2,

        min: sorted[0],

        max: sorted.at(-1),
      },
    ],
  };
};

const multi = (values = [100, 100, 100, 100, 100], options = {}) => {
  const value = report(values, options);

  value.schema = 'bead-bench/2';

  value.method = { ...value.method, runs: 1, processes: values.length, warmup: 1 };

  const row = value.measures[0];

  delete row.samples;

  row.processes = values.map((sample) => {
    return [sample];
  });

  row.medians = values;

  return value;
};

test('compares reports from either side by measure identity and median', () => {
  const base = report();

  const next = report([120, 300, 80], { side: 'csharp' });

  const [row] = compare(base, next);

  assert.equal(row.before, 100);

  assert.equal(row.after, 120);

  assert.equal(row.change, 20);

  assert.equal(row.failed, false);

  assert.ok(Math.abs(compare(next, base)[0].change + 100 / 6) < 1e-12);
});

test('compares a report of the Rust side, which names the runtime it ran on', () => {
  const rust = report([110, 100, 90], { side: 'rust' });

  rust.environment.runtimes = { rustc: '1.99.1' };

  assert.doesNotThrow(() => {
    validate(rust);
  });

  assert.equal(compare(rust, rust)[0].change, 0);

  rust.environment.runtimes = { node: '24.9.0' };

  assert.throws(() => {
    validate(rust);
  }, /CPU, OS, runtime versions/);
});

test('fails only regressions strictly beyond the threshold in each direction', () => {
  const thresholds = thresholdsOf(['25%']);

  assert.equal(compare(multi(), multi(Array(5).fill(125)), thresholds)[0].failed, false);

  assert.equal(compare(multi(), multi(Array(5).fill(126)), thresholds)[0].failed, true);

  assert.equal(compare(multi(), multi(Array(5).fill(50)), thresholds)[0].failed, false);

  const options = { name: 'call.throughput', unit: 'calls/s' };

  assert.equal(
    compare(multi(undefined, options), multi(Array(5).fill(74), options), thresholds)[0].failed,
    true
  );

  assert.equal(
    compare(multi(undefined, options), multi(Array(5).fill(130), options), thresholds)[0].failed,

    false
  );
});

test('applies measure thresholds and identity overrides before the default', () => {
  const thresholds = thresholdsOf(['5%', 'call.p50=30%', 'local.http.0.call.p50=20%']);

  assert.equal(compare(multi(), multi(Array(5).fill(125)), thresholds)[0].failed, true);

  assert.equal(
    compare(multi(), multi(Array(5).fill(125)), thresholdsOf(['5%', 'call.p50=30%']))[0].failed,

    false
  );

  assert.throws(() => {
    compare(multi(), multi(), thresholdsOf(['call.typo=25%']));
  }, /matches no/);
});

test('takes the in-memory transport and the units of exchanges', () => {
  for (const options of [
    { name: 'exchange.throughput', unit: 'exchanges/s' },

    { name: 'exchange.memory', unit: 'B/exchange' },
  ]) {
    const exchanges = report([100], options);

    exchanges.measures[0].transport = 'memory';

    exchanges.measures[0].id = `local.memory.0.${options.name}`;

    assert.equal(compare(exchanges, exchanges)[0].failed, false);
  }
});

test('handles zero baselines and rejects negative allocation counts', () => {
  assert.equal(compare(report([0]), report([0]))[0].change, 0);

  assert.equal(
    compare(multi(Array(5).fill(0)), multi(Array(5).fill(1)), thresholdsOf(['25%']))[0].failed,
    true
  );

  const options = { name: 'call.memory', unit: 'B/call' };

  assert.throws(() => {
    validate(report([-10], options));
  }, /statistics/);
});

test('validates even-run medians, finite samples, counts and statistics', () => {
  assert.equal(validate(report([10, 30])).size, 1);

  for (const mutate of [
    (r) => {
      r.measures[0].median++;
    },

    (r) => {
      r.measures[0].min--;
    },

    (r) => {
      r.measures[0].max++;
    },

    (r) => {
      r.measures[0].samples[0] = NaN;
    },

    (r) => {
      r.method.runs++;
    },

    (r) => {
      r.measures[0].samples = [];
    },

    (r) => {
      r.measures[0].direction = 'higher';
    },

    (r) => {
      r.measures[0].id = 'typo';
    },

    (r) => {
      r.environment.commit = '';
    },

    (r) => {
      delete r.environment.cpu;
    },

    (r) => {
      delete r.method.memory;
    },

    (r) => {
      r.schema = 'other';
    },
  ]) {
    const value = report();

    mutate(value);

    assert.throws(() => {
      validate(value);
    });
  }
});

test('rejects duplicate, missing and incompatible measurements, and lists an added one as new', () => {
  const duplicate = report();

  duplicate.measures.push(duplicate.measures[0]);

  assert.throws(() => {
    validate(duplicate);
  }, /duplicate/);

  const extra = report();

  extra.measures.push(report([100], { name: 'call.p95' }).measures[0]);

  extra.measures[1].samples = [100, 100, 100];

  const added = compare(report(), extra).find((row) => {
    return row.added;
  });

  assert.deepEqual(added, {
    id: 'local.http.0.call.p95',

    unit: 'us',

    after: 100,

    added: true,

    failed: false,
  });

  assert.throws(() => {
    compare(extra, report());
  }, /missing/);

  const incompatible = report();

  incompatible.measures[0].unit = 'ms';

  assert.throws(() => {
    compare(report(), incompatible);
  }, /incompatible/);
});

test('rejects malformed or duplicate thresholds', () => {
  for (const value of ['', '25', '-1%', '25%%', 'x=NaN%', 'Infinity%']) {
    assert.throws(() => {
      thresholdsOf([value]);
    }, /invalid threshold/);
  }

  assert.throws(() => {
    thresholdsOf(['25%', '30%']);
  }, /duplicate/);
});

test('CLI exits 0 for a comparison, 1 for a regression and 2 for input errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bench-compare-'));

  try {
    const base = join(directory, 'base.json');

    const next = join(directory, 'next.json');

    writeFileSync(base, JSON.stringify(multi()));

    writeFileSync(next, JSON.stringify(multi(Array(5).fill(150), { side: 'csharp' })));

    const run = (args) => {
      return spawnSync(process.execPath, ['tools/bench-compare.mjs', ...args], {
        encoding: 'utf8',
      });
    };

    assert.equal(run([base, next]).status, 0);

    const failed = run([base, next, '--threshold', '25%']);

    assert.equal(failed.status, 1);

    assert.match(failed.stdout, /50\.00%.*regression/u);
    assert.match(failed.stdout, /one-sided p.*smallest detectable change/);
    assert.match(failed.stdout, /process medians: baseline/);
    writeFileSync(next, JSON.stringify(multi([50, 75, 150, 200, 300])));
    const unknown = run([base, next, '--threshold', '25%']);
    assert.equal(unknown.status, 0);
    assert.match(unknown.stdout, /inconclusive/);
    writeFileSync(base, JSON.stringify(report()));
    assert.equal(run([base, next, '--threshold', '25%']).status, 2);
    assert.equal(run([base, next]).status, 0);

    for (const args of [
      [base],

      [base, next, '--threshold'],

      [base, next, '--oops'],

      [base, 'missing.json'],
    ]) {
      assert.equal(run(args).status, 2);
    }

    writeFileSync(next, 'broken JSON');

    assert.equal(run([base, next]).status, 2);
  } finally {
    // Windows holds a folder a process just let go a moment longer: its removal is retried

    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test('exact one-sided U matches the small-sample critical tables in both directions', () => {
  for (const [base, next, u, p] of [
    [[1, 2, 3], [4, 5, 6], 9, 1 / 20],

    [[1, 2, 3, 4, 9], [5, 6, 7, 8, 10], 21, 12 / 252],

    [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 25, 1 / 252],

    [[1, 2, 3, 4, 5, 6, 7, 15], [8, 9, 10, 11, 12, 13, 14, 16], 57, 45 / 12870],
  ]) {
    const actual = mannWhitney(base, next);

    assert.equal(actual.u, u);

    assert.equal(actual.p, p);

    assert.deepEqual(mannWhitney(next, base, { direction: 'higher' }), actual);

    assert.ok(mannWhitney(base, next, { direction: 'higher' }).p >= 0.95);
  }
});

test('the exact critical U is 21 of 25, 49 of 64 and 73 of 100 at alpha .05', () => {
  for (const [base, next, u, numerator, denominator] of [
    [[2, 3, 4, 5, 6], [1, 7, 8, 9, 10], 20, 19, 252],
    [[1, 3, 4, 5, 6], [2, 7, 8, 9, 10], 21, 12, 252],
    [[3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 11, 12, 13, 14, 15, 16], 48, 675, 12870],
    [[2, 4, 5, 6, 7, 8, 9, 10], [1, 3, 11, 12, 13, 14, 15, 16], 49, 534, 12870],
    [[3, 4, 6, 7, 8, 9, 10, 11, 12, 13], [1, 2, 5, 14, 15, 16, 17, 18, 19, 20], 72, 9711, 184756],
    [[3, 4, 5, 7, 8, 9, 10, 11, 12, 13], [1, 2, 6, 14, 15, 16, 17, 18, 19, 20], 73, 8241, 184756],
  ]) {
    assert.deepEqual(mannWhitney(base, next), { u, p: numerator / denominator });
    assert.deepEqual(mannWhitney(next, base, { direction: 'higher' }), {
      u,
      p: numerator / denominator,
    });
  }
});

test('enumerates tied observations as distinct labels, with inclusive one-sided tails', () => {
  assert.deepEqual(mannWhitney([1, 1], [1, 2]), { u: 3, p: 0.5 });

  assert.deepEqual(mannWhitney([1, 2], [2, 3]), { u: 3.5, p: 2 / 6 });

  assert.deepEqual(mannWhitney([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]), { u: 12.5, p: 1 });

  assert.deepEqual(mannWhitney([1, 2], [3, 4, 5]), { u: 6, p: 1 / 10 });
});

test('Hodges–Lehmann uses every cross-process ratio rather than a ratio of medians', () => {
  const base = [1, 2, 10];

  const next = [3, 4, 5];

  assert.equal(hodgesLehmann(base, next), 100);

  assert.equal(hodgesLehmann([0], [0]), 0);

  assert.equal(hodgesLehmann([0], [1]), Infinity);
});

test('an effect past the threshold without rank evidence is inconclusive in either direction', () => {
  const thresholds = thresholdsOf(['25%']);

  const next = [50, 75, 150, 200, 300];

  assert.equal(compare(multi(), multi(next), thresholds)[0].verdict, 'inconclusive');

  const options = { name: 'call.throughput', unit: 'calls/s' };

  assert.equal(
    compare(multi(next, options), multi(undefined, options), thresholds)[0].verdict,
    'inconclusive'
  );
});

test('a legacy report prints as one process, and refuses a threshold verdict', () => {
  const base = report();

  assert.deepEqual(compare(base, multi())[0].baseMedians, [100]);

  for (const [before, after] of [
    [base, multi()],
    [multi(), base],
    [multi([1, 2, 3, 4]), multi()],
  ]) {
    assert.throws(() => {
      compare(before, after, thresholdsOf(['25%']));
    }, /at least 5 processes/);
  }
});

test('checks the raw processes, per-process medians and merged statistics', () => {
  for (const mutate of [
    (r) => {
      r.method.processes++;
    },

    (r) => {
      r.method.warmup = -1;
    },

    (r) => {
      r.method.runs++;
    },

    (r) => {
      r.measures[0].processes[0][0]++;
    },

    (r) => {
      r.measures[0].medians[0]++;
    },

    (r) => {
      r.measures[0].processes[0][0] = Infinity;
    },

    (r) => {
      r.measures[0].median++;
    },
  ]) {
    const value = multi();

    mutate(value);

    assert.throws(() => {
      validate(value);
    });
  }
});

test('prints empirical rank resolution and marks unavailable relative resolution at zero', () => {
  assert.equal(smallestDetectableChange([100, 100, 100, 100, 100], [200, 200, 200, 200, 200]), 0);

  assert.ok(smallestDetectableChange([80, 90, 100, 110, 120], [80, 90, 100, 110, 120]) > 0);

  assert.equal(smallestDetectableChange([0], [0]), null);

  assert.equal(smallestDetectableChange([100], [100]), null);
});
