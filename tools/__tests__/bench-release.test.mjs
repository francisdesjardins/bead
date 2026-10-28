import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, level, merge, parse } from '../bench-release.mjs';
import { validate } from '../bench-compare.mjs';

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

const fresh = () => {
  return Array.from({ length: 5 }, (_, index) => {
    return report([999, 10 + index, 20 + index]);
  });
};

test('keeps raw runs and warmups, and summarizes the medians of independent processes', () => {
  const merged = merge(fresh());
  assert.equal(merged.schema, 'bead-bench/2');
  assert.equal(merged.method.processes, 5);
  assert.equal(merged.method.runs, 2);
  assert.equal(merged.method.warmup, 1);
  assert.deepEqual(merged.measures[0].processes, [
    [10, 20],
    [11, 21],
    [12, 22],
    [13, 23],
    [14, 24],
  ]);
  assert.deepEqual(merged.measures[0].warmups, Array(5).fill([999]));
  assert.deepEqual(merged.measures[0].medians, [15, 16, 17, 18, 19]);
  assert.equal(merged.measures[0].median, 17);
  assert.equal(merged.measures[0].min, 15);
  assert.equal(merged.measures[0].max, 19);
  assert.equal('samples' in merged.measures[0], false);
  assert.equal(validate(merged).size, 1);
});

test('refuses processes differing in side, commit, runtimes, environment, method or IDs', () => {
  for (const mutate of [
    (r) => {
      r.side = 'csharp';
    },
    (r) => {
      r.environment.commit = 'b'.repeat(40);
    },
    (r) => {
      r.environment.runtimes.node = 'other';
    },
    (r) => {
      r.environment.cpu.count++;
    },
    (r) => {
      r.method.seconds++;
    },
    (r) => {
      r.method.filter = 'call.p95';
    },
    (r) => {
      r.measures[0].name = 'call.p95';
      r.measures[0].id = 'local.http.0.call.p95';
    },
    (r) => {
      r.measures[0].unit = 'ms';
    },
    (r) => {
      const extra = structuredClone(r.measures[0]);
      extra.name = 'call.p95';
      extra.id = 'local.http.0.call.p95';
      r.measures.push(extra);
    },
    (r) => {
      r.measures[0].samples = [];
    },
  ]) {
    const reports = fresh();
    mutate(reports[1]);
    assert.throws(() => {
      merge(reports);
    });
  }
  assert.throws(() => {
    merge(fresh().slice(1));
  }, /at least 5/);
  assert.throws(() => {
    merge(fresh(), { warmup: 3 });
  }, /recorded run/);
  assert.throws(() => {
    merge(fresh(), { warmup: -1 });
  }, /warmup/);
  assert.throws(() => {
    merge(Array(5).fill(merge(fresh())));
  }, /fresh process/);
});

test('runs baseline and candidate in alternating fresh processes, in ABBA order, and drops the first run alike', async () => {
  const order = [];
  const values = await collect(['baseline', 'candidate'], {
    processes: 5,
    run: async (tree, index) => {
      order.push(`${tree}:${index}`);
      const result = fresh()[index];
      result.environment.commit = (tree === 'baseline' ? 'a' : 'b').repeat(40);
      return result;
    },
  });
  assert.deepEqual(
    order,
    Array.from({ length: 5 }, (_, index) => {
      return index % 2 === 0
        ? [`baseline:${index}`, `candidate:${index}`]
        : [`candidate:${index}`, `baseline:${index}`];
    }).flat()
  );
  assert.equal(values.length, 2);
  assert.equal(values[0].environment.commit, 'a'.repeat(40));
  assert.equal(values[1].environment.commit, 'b'.repeat(40));
  assert.equal(values[1].measures[0].median, 17);
});

test('a failed process fails collection and launches no further process', async () => {
  let count = 0;
  await assert.rejects(
    collect(['candidate'], {
      processes: 5,
      run: async () => {
        if (++count === 2) {
          throw new Error('process exits 1');
        }
        return fresh()[0];
      },
    }),
    /process exits 1/
  );
  assert.equal(count, 2);
});

test('selects a legacy whole bench by exact ID or name, and refuses an unmatched filter', async () => {
  for (const filter of ['call.p50', 'local.http.0.call.p50']) {
    const [value] = await collect(['candidate'], {
      processes: 5,
      filter,
      run: async () => {
        return fresh()[0];
      },
    });
    assert.equal(value.measures.length, 1);
    assert.equal(value.method.filter, filter);
  }
  await assert.rejects(
    collect(['candidate'], {
      processes: 5,
      filter: 'typo',
      run: async () => {
        return fresh()[0];
      },
    }),
    /matches no/
  );
});

test('passes a filter to the benches only when every one takes it, so a measure meets the same phases in each', () => {
  const options = { side: 'csharp', filter: 'call.throughput' };
  assert.equal(level([true, true], options), options);
  assert.equal(level([false, true], options).filter, undefined);
  assert.equal(level([true, false], options).side, 'csharp');
  assert.equal(options.filter, 'call.throughput');
  const whole = { side: 'csharp' };
  assert.equal(level([false, true], whole), whole);
});

test('takes the Rust side as it takes the others', () => {
  assert.deepEqual(parse(['rust']), {
    side: 'rust',
    processes: 5,
    runs: 2,
    seconds: 3,
    transcoding: false,
  });
});

test('defaults to five processes and two recorded runs and validates CLI options', () => {
  assert.deepEqual(parse(['typescript']), {
    side: 'typescript',
    processes: 5,
    runs: 2,
    seconds: 3,
    transcoding: false,
  });
  assert.equal(
    parse([
      'csharp',
      '--tree',
      'v070',
      '--baseline-output',
      'before.json',
      '--output',
      'after.json',
      '--filter',
      'call.p99',
    ]).filter,
    'call.p99'
  );
  for (const args of [
    [],
    ['other'],
    ['typescript', '--processes', '4'],
    ['typescript', '--runs', '0'],
    ['typescript', '--seconds'],
    ['typescript', '--tree', 'v070'],
    ['typescript', '--baseline-output', 'before.json'],
    ['typescript', '--filter'],
    ['typescript', '--filter', '--transcoding'],
    ['typescript', '--unknown'],
    ['typescript', '--runs', '2', '--runs', '2'],
    ['typescript', '--tree', 'v070', '--baseline-output', 'same.json', '--output', './same.json'],
  ]) {
    assert.throws(() => {
      parse(args);
    });
  }
});
