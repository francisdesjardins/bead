import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { MARKER_FILE, NEWBORN, STALE_AFTER, WORK_AREAS } from '../work-area.ts';

const MODULE = new URL('../work-area.ts', import.meta.url).href;
const HOUR = 60 * 60 * 1000;

// ! each case's children get a temporary folder of its own: a planted area in the system's would
// be swept by any other case's run
const temporaryOfCase = (): string => {
  const folder = test.info().outputPath('tmp');

  mkdirSync(folder, { recursive: true });

  return folder;
};

const envOf = (temporary: string): NodeJS.ProcessEnv => {
  return { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
};

// `code` run as a module in a child whose temporary folder is `temporary`, the work area's module
// as `area`
const child = (
  temporary: string,
  code: string
): { status: number | null; stdout: string; stderr: string } => {
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const area = await import(${JSON.stringify(MODULE)});\n${code}`],
    { encoding: 'utf8', env: envOf(temporary) }
  );

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

// a child that makes its work area, prints it, and waits to be ended
const waiting = async (
  temporary: string,
  options: { readonly signals: boolean }
): Promise<{
  area: string;
  ended: Promise<number | null>;
  kill: (signal: NodeJS.Signals) => void;
}> => {
  const running = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const area = await import(${JSON.stringify(MODULE)});`,
        options.signals ? 'area.removeWorkAreaOnSignals();' : '',
        "process.stdout.write(area.temporaryFolderOf('buf-') + '\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    ],
    { env: envOf(temporary), stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const ended = new Promise<number | null>((resolve) => {
    running.once('exit', (code) => {
      resolve(code);
    });
  });
  const folder = await new Promise<string>((resolve) => {
    let text = '';

    running.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');

      if (text.includes('\n')) {
        resolve(text.trim());
      }
    });
  });

  return {
    area: dirname(folder),
    ended,
    kill: (signal) => {
      running.kill(signal);
    },
  };
};

// an area planted under `temporary`: its marker, where given, and its folder's time
const plant = (
  temporary: string,
  options: {
    readonly name: string;
    readonly marker?: { readonly pid: number; readonly started: string };
    readonly age: number;
    readonly bytes?: number;
  }
): string => {
  const area = join(temporary, WORK_AREAS, options.name);

  mkdirSync(join(area, 'buf-x'), { recursive: true });

  if (options.bytes !== undefined) {
    writeFileSync(join(area, 'buf-x', 'set.binpb'), Buffer.alloc(options.bytes));
  }

  if (options.marker !== undefined) {
    writeFileSync(join(area, MARKER_FILE), JSON.stringify(options.marker));
  }

  const time = new Date(Date.now() - options.age);

  utimesSync(area, time, time);

  return area;
};

// a pid no process holds: past every system's bound, and a signal 0 to it answers ESRCH
const DEAD_PID = 2 ** 31 - 1;

test("a run's work area lies under the system's temporary folder, its marker naming its process", () => {
  const temporary = temporaryOfCase();
  const run = child(
    temporary,
    [
      "const folder = area.temporaryFolderOf('buf-');",
      "const { readFileSync } = await import('node:fs');",
      "const { join } = await import('node:path');",
      'const marker = JSON.parse(readFileSync(join(area.workArea(), area.MARKER_FILE), "utf8"));',
      'process.stdout.write(JSON.stringify({ folder, area: area.workArea(), marker, pid: process.pid }));',
    ].join('\n')
  );

  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);

  const made = JSON.parse(run.stdout) as {
    folder: string;
    area: string;
    marker: { pid: number; started: string };
    pid: number;
  };

  expect(dirname(made.area)).toBe(join(temporary, WORK_AREAS));
  expect(basename(made.area)).toMatch(/^run-/u);
  expect(dirname(made.folder)).toBe(made.area);
  expect(made.marker.pid).toBe(made.pid);
  expect(Number.isNaN(Date.parse(made.marker.started))).toBe(false);
  // * removed as the process exits
  expect(existsSync(made.area)).toBe(false);
  expect(readdirSync(join(temporary, WORK_AREAS))).toEqual([]);
});

test("a run's work area is removed when the run fails", () => {
  const temporary = temporaryOfCase();
  const run = child(
    temporary,
    [
      "const folder = area.temporaryFolderOf('protoc-');",
      "const { writeFileSync } = await import('node:fs');",
      "writeFileSync(folder + '/set.binpb', 'set');",
      "throw new Error('the run fails');",
    ].join('\n')
  );

  expect(run.status).toBe(1);
  expect(run.stderr).toContain('the run fails');
  expect(readdirSync(join(temporary, WORK_AREAS))).toEqual([]);
});

test("a run's work area is removed as SIGINT or SIGTERM ends it, its exit the signal's", async () => {
  test.skip(
    process.platform === 'win32',
    "Windows ends a child without a signal it can catch, and a console's Ctrl+C reaches no test's child"
  );

  for (const [signal, exit] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    const temporary = test.info().outputPath(signal);

    mkdirSync(temporary, { recursive: true });

    const running = await waiting(temporary, { signals: true });

    expect(existsSync(running.area)).toBe(true);
    running.kill(signal);
    expect(await running.ended, signal).toBe(exit);
    expect(readdirSync(join(temporary, WORK_AREAS)), signal).toEqual([]);
  }
});

test('a run ended outright leaves its area, which the next run sweeps', async () => {
  const temporary = temporaryOfCase();
  const running = await waiting(temporary, { signals: false });

  running.kill('SIGKILL');
  await running.ended;
  expect(existsSync(running.area)).toBe(true);

  const sweep = child(temporary, 'process.stdout.write(JSON.stringify(area.sweepWorkAreas()));');

  expect(sweep.stderr).toBe('');
  expect(
    (JSON.parse(sweep.stdout) as { path: string }[]).map((swept) => {
      return swept.path;
    })
  ).toEqual([running.area]);
  expect(readdirSync(join(temporary, WORK_AREAS))).toEqual([]);
});

test("the sweep removes a dead process's area and an old one without a marker, never a running process's", () => {
  const temporary = temporaryOfCase();
  const started = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
  const dead = plant(temporary, {
    name: 'run-dead',
    marker: { pid: DEAD_PID, started },
    age: 0,
    bytes: 100,
  });
  const old = plant(temporary, { name: 'run-old', age: STALE_AFTER + HOUR, bytes: 10 });
  const running = plant(temporary, {
    name: 'run-running',
    marker: { pid: process.pid, started },
    age: 30 * 24 * HOUR,
  });
  const young = plant(temporary, { name: 'run-young', age: 10 * NEWBORN });
  const newborn = plant(temporary, { name: 'run-newborn', age: 0 });
  const other = plant(temporary, { name: 'other', age: STALE_AFTER + HOUR });
  const sweep = (all: boolean): { path: string; bytes: number }[] => {
    const run = child(
      temporary,
      `process.stdout.write(JSON.stringify(area.sweepWorkAreas({ all: ${String(all)} })));`
    );

    expect(run.stderr).toBe('');

    return JSON.parse(run.stdout) as { path: string; bytes: number }[];
  };
  const swept = sweep(false).toSorted((a, b) => {
    return a.path.localeCompare(b.path);
  });

  expect(
    swept.map((area) => {
      return area.path;
    })
  ).toEqual([dead, old]);
  expect(swept[0]?.bytes).toBeGreaterThan(100);
  expect(swept[1]?.bytes).toBe(10);

  // * --all: an area without a marker goes at any age but a newborn's
  expect(
    sweep(true).map((area) => {
      return area.path;
    })
  ).toEqual([young]);
  expect(readdirSync(join(temporary, WORK_AREAS)).toSorted()).toEqual(
    [basename(newborn), basename(other), basename(running)].toSorted()
  );
  expect(existsSync(other)).toBe(true);
});

test('the sweep never follows a link, an area’s name or the areas’ folder’s', () => {
  const temporary = temporaryOfCase();
  const target = test.info().outputPath('target');
  const kept = join(target, 'kept.proto');

  mkdirSync(join(temporary, WORK_AREAS), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(kept, 'syntax = "proto3";\n');

  const time = new Date(Date.now() - STALE_AFTER - HOUR);

  utimesSync(target, time, time);
  // * a junction where Windows has it, which takes no right to make; a symbolic link elsewhere
  symlinkSync(target, join(temporary, WORK_AREAS, 'run-link'), 'junction');

  const sweep = (): unknown => {
    const run = child(
      temporary,
      'process.stdout.write(JSON.stringify(area.sweepWorkAreas({ all: true })));'
    );

    expect(run.stderr).toBe('');

    return JSON.parse(run.stdout);
  };

  expect(sweep()).toEqual([]);
  expect(existsSync(kept)).toBe(true);

  // * the areas' folder itself a link to a folder of areas
  const elsewhere = test.info().outputPath('elsewhere');
  const linked = test.info().outputPath('linked');

  plant(elsewhere, { name: 'run-old', age: STALE_AFTER + HOUR });
  mkdirSync(linked, { recursive: true });
  symlinkSync(join(elsewhere, WORK_AREAS), join(linked, WORK_AREAS), 'junction');

  const run = child(linked, 'process.stdout.write(JSON.stringify(area.sweepWorkAreas()));');

  expect(run.stdout).toBe('[]');
  expect(existsSync(join(elsewhere, WORK_AREAS, 'run-old'))).toBe(true);
});

test('the sweep finds nothing where no run made the areas’ folder', () => {
  const temporary = temporaryOfCase();
  const run = child(temporary, 'process.stdout.write(JSON.stringify(area.sweepWorkAreas()));');

  expect(run.stderr).toBe('');
  expect(run.stdout).toBe('[]');
});
