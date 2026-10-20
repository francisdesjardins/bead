import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compare, thresholdsOf, validate } from '../bench-compare.mjs';

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

test('fails only regressions strictly beyond the threshold in each direction', () => {
  const thresholds = thresholdsOf(['25%']);
  assert.equal(compare(report(), report([125]), thresholds)[0].failed, false);
  assert.equal(compare(report(), report([126]), thresholds)[0].failed, true);
  assert.equal(compare(report(), report([50]), thresholds)[0].failed, false);
  const options = { name: 'call.throughput', unit: 'calls/s' };
  assert.equal(compare(report([100], options), report([74], options), thresholds)[0].failed, true);
  assert.equal(
    compare(report([100], options), report([130], options), thresholds)[0].failed,
    false
  );
});

test('applies measure thresholds and identity overrides before the default', () => {
  const thresholds = thresholdsOf(['5%', 'call.p50=30%', 'local.http.0.call.p50=20%']);
  assert.equal(compare(report(), report([125]), thresholds)[0].failed, true);
  assert.equal(
    compare(report(), report([125]), thresholdsOf(['5%', 'call.p50=30%']))[0].failed,
    false
  );
  assert.throws(() => {
    compare(report(), report(), thresholdsOf(['call.typo=25%']));
  }, /matches no/);
});

test('handles zero baselines and rejects negative allocation counts', () => {
  assert.equal(compare(report([0]), report([0]))[0].change, 0);
  assert.equal(compare(report([0]), report([1]), thresholdsOf(['25%']))[0].failed, true);
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

test('rejects duplicate, missing, additional and incompatible measurements', () => {
  const duplicate = report();
  duplicate.measures.push(duplicate.measures[0]);
  assert.throws(() => {
    validate(duplicate);
  }, /duplicate/);
  const extra = report();
  extra.measures.push(report([100], { name: 'call.p95' }).measures[0]);
  extra.measures[1].samples = [100, 100, 100];
  assert.throws(() => {
    compare(report(), extra);
  }, /different measurement sets/);
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
    writeFileSync(base, JSON.stringify(report()));
    writeFileSync(next, JSON.stringify(report([150], { side: 'csharp' })));
    const run = (args) => {
      return spawnSync(process.execPath, ['tools/bench-compare.mjs', ...args], {
        encoding: 'utf8',
      });
    };
    assert.equal(run([base, next]).status, 0);
    const failed = run([base, next, '--threshold', '25%']);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /50\.00%.*regression/u);
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
    rmSync(directory, { recursive: true, force: true });
  }
});
