import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { initProject } from '../init.ts';
import { protocPin } from '../protoc.ts';
import { beadcVersion, specVersion } from '../version.ts';
import { IMAGE, WRAPPERS, type WrapperName, wrapperText } from '../wrappers.ts';
import { needsProtoc } from './pinned.ts';

// ── The wrappers ──────────────────────────────────────────────────────────────

// The two wrappers held to one contract: each case runs beadc.sh under bash and beadc.ps1 under
// pwsh, both by `pwsh -File` and inside a session, against a stand-in engine that records each call,
// and asserts one call list, one output and one exit, so a difference between them is a red test.
// A test skips, with its reason, where bash or pwsh 7.6 is missing, or where Windows refuses the
// process a symbolic link; with `BEADC_WRAPPERS_REQUIRED=1`, as CI's `builder` job sets it, it runs
// anyway and fails. The tests that run beadc's image through the wrappers skip without
// `BEADC_IMAGE`, and fail without it under `BEADC_IMAGE_REQUIRED=1`.

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../wrappers/', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const MESSAGES = fileURLToPath(new URL('../../test/messages/', import.meta.url));

const WINDOWS = process.platform === 'win32';
const WRAPPERS_REQUIRED = process.env['BEADC_WRAPPERS_REQUIRED'] === '1';
const IMAGE_UNDER_TEST = process.env['BEADC_IMAGE'];
const IMAGE_REQUIRED = process.env['BEADC_IMAGE_REQUIRED'] === '1';

// the image the stand-in is asked to run, and what it writes from `run`, UTF-8 and LF on both
const STAND_IN_IMAGE = 'beadc:stand-in';
const STAND_IN_STDOUT = 'café 1\nline 2\n';
const STAND_IN_STDERR = 'err é\n';

// the flags of every run, before the user's
const RUN_FLAGS = [
  'run',
  '--rm',
  '--init',
  '--network',
  'none',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--security-opt',
  'label=disable',
];

const DOCKER_FORMAT =
  '{{.OSType}} {{range .SecurityOptions}}{{if eq . "name=rootless"}}true{{end}}{{end}}';
const PODMAN_FORMAT = '{{.Host.OS}} {{.Host.Security.Rootless}}';

// the stand-in engine, CommonJS so that Node builds it into a single executable: it records each
// call, a JSON array a line, in BEADC_PROBE_LOG; answers --version as its name or
// BEADC_PROBE_VERSION says, and info with BEADC_PROBE_INFO, or exits 1 when that is "stopped"; and
// from run writes UTF-8 on both streams and exits BEADC_PROBE_EXIT, 1 unless given
const STAND_IN = `'use strict';
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');

const args = process.argv.slice(2);
const self = process.env.BEADC_PROBE_SELF ?? basename(process.execPath).replace(/\\.exe$/iu, '');

appendFileSync(process.env.BEADC_PROBE_LOG, JSON.stringify(args) + '\\n');

if (args[0] === '--version') {
  const podman = self.toLowerCase() === 'podman';

  process.stdout.write(
    (process.env.BEADC_PROBE_VERSION ??
      (podman ? 'podman version 5.6.0' : 'Docker version 29.4.2, build stand-in')) + '\\n'
  );
} else if (args[0] === 'info') {
  const info = process.env.BEADC_PROBE_INFO ?? 'linux ';

  if (info === 'stopped') {
    process.exitCode = 1;
  } else {
    process.stdout.write(info + '\\n');
  }
} else {
  process.stdout.write(Buffer.from(${JSON.stringify(STAND_IN_STDOUT)}, 'utf8'));
  process.stderr.write(Buffer.from(${JSON.stringify(STAND_IN_STDERR)}, 'utf8'));
  process.exitCode = Number(process.env.BEADC_PROBE_EXIT ?? '1');
}
`;

// what a run gives: the engine's calls, each as its arguments, and the bytes and the exit
interface IRun {
  readonly calls: readonly (readonly string[])[];
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

// how a wrapper is run: beadc.sh by bash; beadc.ps1 by pwsh -File, or from a session
const Way = Object.freeze({
  BASH: 'bash',
  PWSH_FILE: 'pwsh -File',
  PWSH_SESSION: 'pwsh session',
} as const);

type Way = (typeof Way)[keyof typeof Way];

const WAYS: readonly Way[] = Object.values(Way);

// ── The shells ────────────────────────────────────────────────────────────────

// bash: on Windows Git Bash, found from git, never the bash on the path, which is WSL's on a machine
// that has it; elsewhere the path's
const bashOf = (): string | undefined => {
  if (!WINDOWS) {
    return spawnSync('bash', ['--version']).status === 0 ? 'bash' : undefined;
  }

  const found = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });

  if (found.status !== 0) {
    return undefined;
  }

  // * <git>/mingw64/libexec/git-core: <git>/bin/bash.exe sets the path Git Bash's tools are on
  const bash = join(found.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe');

  return existsSync(bash) ? bash : undefined;
};

// pwsh's version, when one runs
const pwshVersionOf = (): string | undefined => {
  const found = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    { encoding: 'utf8' }
  );

  return found.status === 0 ? found.stdout.trim() : undefined;
};

let shells: { readonly bash?: string; readonly missing?: string } | undefined;

// the shells, looked for once a worker: why a wrapper's test cannot run, when it cannot
const shellsOf = (): { readonly bash?: string; readonly missing?: string } => {
  if (shells !== undefined) {
    return shells;
  }

  const bash = bashOf();
  const pwsh = pwshVersionOf();
  const [major = 0, minor = 0] = (pwsh ?? '0.0').split('.').map(Number);
  const missing = [
    ...(bash === undefined ? [WINDOWS ? 'no Git Bash beside git' : 'no bash on the path'] : []),
    ...(pwsh === undefined
      ? ['no pwsh on the path']
      : major < 7 || (major === 7 && minor < 6)
        ? [`pwsh ${pwsh}, where beadc.ps1 asks 7.6 or later`]
        : []),
  ].join('; ');

  shells = { ...(bash === undefined ? {} : { bash }), ...(missing === '' ? {} : { missing }) };

  return shells;
};

// skips the running test without bash or pwsh 7.6, unless they are required; gives bash
const needsShells = (): string => {
  const { bash, missing } = shellsOf();

  test.skip(missing !== undefined && !WRAPPERS_REQUIRED, missing);
  expect(missing, 'BEADC_WRAPPERS_REQUIRED=1').toBeUndefined();

  return bash ?? 'bash';
};

// skips the running test without an image to run, unless one is required; gives the image
const needsImage = (): string => {
  test.skip(
    IMAGE_UNDER_TEST === undefined && !IMAGE_REQUIRED,
    'no BEADC_IMAGE: docker build -f builder/Dockerfile -t beadc:local ., then BEADC_IMAGE=beadc:local'
  );
  expect(IMAGE_UNDER_TEST, 'BEADC_IMAGE_REQUIRED=1').toBeDefined();

  return IMAGE_UNDER_TEST ?? '';
};

// ── The stand-in ──────────────────────────────────────────────────────────────

let standIn: string | undefined;

// the stand-in's folder, built once a run into the tests' output folder: on Windows a native
// docker.exe, Node's single executable, which both shells reach as they reach Docker Desktop's, with
// no cmd.exe between pwsh and the arguments; elsewhere a script of each name that runs it on Node
const standInOf = (): string => {
  if (standIn !== undefined) {
    return standIn;
  }

  const folder = join(test.info().project.outputDir, 'stand-in');

  if (!existsSync(folder)) {
    const building = mkdtempSync(`${folder}-`);

    writeFileSync(join(building, 'stand-in.cjs'), STAND_IN);

    if (WINDOWS) {
      writeFileSync(
        join(building, 'sea.json'),
        JSON.stringify({
          main: 'stand-in.cjs',
          output: 'docker.exe',
          disableExperimentalSEAWarning: true,
        })
      );

      const built = spawnSync(process.execPath, ['--build-sea', 'sea.json'], {
        cwd: building,
        encoding: 'utf8',
      });

      expect(built.status, `node --build-sea: ${built.stderr}`).toBe(0);
      linkSync(join(building, 'docker.exe'), join(building, 'podman.exe'));
    } else {
      for (const name of ['docker', 'podman', 'Podman']) {
        writeFileSync(
          join(building, name),
          `#!/bin/sh\nBEADC_PROBE_SELF=${name} exec '${process.execPath}' '${join(folder, 'stand-in.cjs')}' "$@"\n`,
          { mode: 0o755 }
        );
      }
    }

    // * another worker may have built it first: its build then stands
    try {
      renameSync(building, folder);
    } catch {
      rmSync(building, { recursive: true, force: true });
    }
  }

  standIn = folder;

  return folder;
};

// ── Running a wrapper ─────────────────────────────────────────────────────────

// the process's environment with `changes` made, a name of the path's matched in any case, as
// Windows matches it; `undefined` takes a variable out
const environmentWith = (
  changes: Readonly<Record<string, string | undefined>>
): Record<string, string> => {
  const environment: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    const changed = Object.keys(changes).some((key) => {
      return key.toUpperCase() === name.toUpperCase();
    });

    if (value !== undefined && !changed) {
      environment[name] = value;
    }
  }

  for (const [name, value] of Object.entries(changes)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

const PATH_NAME =
  Object.keys(process.env).find((name) => {
    return name.toUpperCase() === 'PATH';
  }) ?? 'PATH';

// the wrapper `name`, filled as `beadc wrapper` prints it, in the running test's output folder
const filled = (name: WrapperName): string => {
  const path = test.info().outputPath(name);

  if (!existsSync(path)) {
    writeFileSync(path, wrapperText(name, { version: beadcVersion() }));
  }

  return path;
};

// a PowerShell string literal of `text`
const quoted = (text: string): string => {
  return `'${text.replaceAll("'", "''")}'`;
};

// the lines of `text`, each ended LF, as each wrapper writes them
const unixLines = (text: string): string => {
  return text.replaceAll('\r\n', '\n');
};

const callsOf = (log: string): (readonly string[])[] => {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => {
          return line !== '';
        })
        .map((line) => {
          return JSON.parse(line) as string[];
        })
    : [];
};

let runs = 0;

/**
 * Runs a wrapper `way` with `args` from `options.cwd`, its environment changed by `options.env`. In
 * a session, the wrapper is called from a script that goes to `options.cwd` by Set-Location and
 * redirects both streams to files, `options.tokens` its arguments as PowerShell reads them, each
 * quoted unless given.
 */
const runWay = (
  way: Way,
  options: {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly bash: string;
    readonly tokens?: readonly string[];
  }
): IRun => {
  runs += 1;

  const scratch = test.info().outputPath(`run-${String(runs)}`);
  const log = join(scratch, 'calls.log');

  mkdirSync(scratch, { recursive: true });

  const env = environmentWith({ BEADC_PROBE_LOG: log, ...options.env });
  const spawned = { cwd: options.cwd, env };

  switch (way) {
    case Way.BASH: {
      const run = spawnSync(
        options.bash,
        [filled('beadc.sh').replaceAll('\\', '/'), ...options.args],
        spawned
      );

      return {
        calls: callsOf(log),
        stdout: run.stdout.toString('utf8'),
        stderr: run.stderr.toString('utf8'),
        status: run.status,
      };
    }
    case Way.PWSH_FILE: {
      const run = spawnSync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', filled('beadc.ps1'), ...options.args],
        spawned
      );

      return {
        calls: callsOf(log),
        stdout: run.stdout.toString('utf8'),
        stderr: run.stderr.toString('utf8'),
        status: run.status,
      };
    }
    case Way.PWSH_SESSION: {
      const out = join(scratch, 'out');
      const err = join(scratch, 'err');
      const session = join(scratch, 'session.ps1');
      const tokens = options.tokens ?? options.args.map(quoted);

      writeFileSync(
        session,
        [
          `Set-Location -LiteralPath ${quoted(options.cwd)}`,
          `& ${quoted(filled('beadc.ps1'))} ${tokens.join(' ')} > ${quoted(out)} 2> ${quoted(err)}`,
          'exit $LASTEXITCODE',
          '',
        ].join('\n')
      );

      // * from the scratch folder: the session reaches the case's folder by Set-Location
      const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', session], {
        cwd: scratch,
        env,
      });
      const read = (file: string): string => {
        return existsSync(file) ? readFileSync(file, 'utf8') : '';
      };

      // ! what the wrapper writes itself goes to the process's stderr, not through 2>
      return {
        calls: callsOf(log),
        stdout: read(out) + run.stdout.toString('utf8'),
        stderr: read(err) + run.stderr.toString('utf8'),
        status: run.status,
      };
    }
  }
};

// each way's run, the stand-in first on the path and the image the stand-in's
const runEach = (options: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bash: string;
}): ReadonlyMap<Way, IRun> => {
  const env = {
    [PATH_NAME]: `${standInOf()}${delimiter}${process.env[PATH_NAME] ?? ''}`,
    BEADC_IMAGE: STAND_IN_IMAGE,
    BEADC_ENGINE: undefined,
    BEADC_PROBE_VERSION: undefined,
    BEADC_PROBE_INFO: undefined,
    BEADC_PROBE_EXIT: undefined,
    ...options.env,
  };

  return new Map(
    WAYS.map((way) => {
      return [way, runWay(way, { ...options, env })] as const;
    })
  );
};

// a run with each line ended LF: a session's > ends each with CRLF on Windows, a platform row
const parityOf = (run: IRun): IRun => {
  return { ...run, stdout: unixLines(run.stdout), stderr: unixLines(run.stderr) };
};

// asserts that every way made the same calls, printed the same bytes and exited alike; gives bash's
const sameOf = (each: ReadonlyMap<Way, IRun>): IRun => {
  const bash = each.get(Way.BASH);

  if (bash === undefined) {
    throw new Error('no run of beadc.sh');
  }

  for (const way of [Way.PWSH_FILE, Way.PWSH_SESSION]) {
    expect(parityOf(each.get(way) ?? bash), `${way} against bash`).toEqual(bash);
  }

  return bash;
};

// the caller's user, as both wrappers pass it on this host to a rootful engine
const callerUser = (): readonly string[] => {
  return WINDOWS
    ? ['--user', '65532:65532']
    : ['--user', `${String(process.getuid?.())}:${String(process.getgid?.())}`];
};

// the run a wrapper asks of the engine, the project's root at `source`
const runCall = (details: {
  readonly user: readonly string[];
  readonly source: string;
  readonly workdir: string;
  readonly args: readonly string[];
}): readonly string[] => {
  return [
    ...RUN_FLAGS,
    ...details.user,
    '--mount',
    `type=bind,"source=${details.source}",target=/work`,
    '--workdir',
    details.workdir,
    STAND_IN_IMAGE,
    ...details.args,
  ];
};

// a folder's physical path, as the system gives it
const physicalOf = (folder: string): string => {
  return realpathSync.native(folder);
};

// a project in the running test's output folder, `beadc.yaml` at `root` and `sub` under it
const projectOf = (root: string, sub: string): string => {
  const folder = test.info().outputPath(root);

  mkdirSync(join(folder, sub), { recursive: true });
  writeFileSync(join(folder, 'beadc.yaml'), 'version: 1\n');

  return folder;
};

// a link at `path` to `target`: a junction on Windows unless a symbolic link is asked
const linkOf = (
  target: string,
  path: string,
  options: { readonly kind?: 'junction' | 'dir' } = {}
): void => {
  try {
    symlinkSync(target, path, WINDOWS ? (options.kind ?? 'junction') : 'dir');
  } catch (error) {
    const code = (error as { code?: unknown }).code;

    test.skip(
      code === 'EPERM' && !WRAPPERS_REQUIRED,
      'a symbolic link asks for Developer Mode or an elevated process on Windows'
    );
    throw error;
  }
};

// ── The cases ─────────────────────────────────────────────────────────────────

interface ICase {
  readonly name: string;
  readonly on?: 'windows' | 'posix';
  // the folder it runs from and the root the wrappers find, made in the running test's folder
  readonly folders: () => { readonly cwd: string; readonly root: string };
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  // what the case expects of bash's run, the folders known
  readonly expected: (folders: { readonly cwd: string; readonly root: string }) => IExpected;
}

// what a case expects: the calls whole, or the info's format and the run; the bytes and the exit
interface IExpected {
  readonly calls?: readonly (readonly string[])[];
  readonly info?: string;
  readonly run?: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status: number;
}

// a project with a space and a comma in its name, run from a folder under it
const upward = (): { cwd: string; root: string } => {
  const root = projectOf('my project, one', 'sub dir');

  return { cwd: join(root, 'sub dir'), root };
};

// the run of a case at its root, from the root itself
const atRoot = (): { cwd: string; root: string } => {
  const root = projectOf('project', '.');

  return { cwd: root, root };
};

// what bash's run of a run with `user` and `args` is, its folders known
const ranWith = (
  user: readonly string[],
  details: {
    readonly args?: readonly string[];
    readonly workdir?: string;
    readonly info?: string;
  } = {}
) => {
  return (folders: { readonly cwd: string; readonly root: string }): IExpected => {
    return {
      info: details.info ?? DOCKER_FORMAT,
      run: runCall({
        user,
        source: physicalOf(folders.root),
        workdir: details.workdir ?? '/work',
        args: details.args ?? ['version'],
      }),
      stdout: STAND_IN_STDOUT,
      stderr: STAND_IN_STDERR,
      status: 1,
    };
  };
};

const environmentFailure = (message: string, calls: readonly (readonly string[])[]) => {
  return (): IExpected => {
    return { calls, stdout: '', stderr: `beadc: ${message}\n`, status: 3 };
  };
};

const ARGUMENTS = ['check', 'a b', '', 'x"y', 'a\\b', 'a&b', '100%PATH%', 'a^b'];

const CASES: readonly ICase[] = [
  {
    name: 'upward from a folder with a space',
    folders: upward,
    expected: (folders) => {
      return ranWith(callerUser(), { workdir: '/work/sub dir' })(folders);
    },
  },
  {
    name: 'through a link, from a shell and from a pwsh session',
    folders: () => {
      const root = projectOf('target', 'sub');
      const link = test.info().outputPath('link');

      linkOf(root, link);

      return { cwd: join(link, 'sub'), root };
    },
    expected: ranWith(callerUser(), { workdir: '/work/sub' }),
  },
  {
    name: 'through a junction through a junction',
    on: 'windows',
    folders: () => {
      const root = projectOf('r', join('deep', 'proj', 'sub'));
      const x = test.info().outputPath('x');

      mkdirSync(x, { recursive: true });
      linkOf(join(root, 'deep'), join(x, 'b'));
      linkOf(join(x, 'b', 'proj'), test.info().outputPath('l1'));

      return { cwd: join(test.info().outputPath('l1'), 'sub'), root };
    },
    expected: ranWith(callerUser(), { workdir: '/work/deep/proj/sub' }),
  },
  {
    name: 'through a directory symbolic link',
    on: 'windows',
    folders: () => {
      const root = projectOf('target', 'sub');
      const link = test.info().outputPath('link');

      linkOf(root, link, { kind: 'dir' });

      return { cwd: join(link, 'sub'), root };
    },
    expected: ranWith(callerUser(), { workdir: '/work/sub' }),
  },
  {
    name: 'through a link whose target crosses a link',
    on: 'posix',
    folders: () => {
      const root = projectOf('r', join('deep', 'proj', 'sub'));
      const x = test.info().outputPath('x');

      mkdirSync(x, { recursive: true });
      linkOf(join(root, 'deep'), join(x, 'b'));
      linkOf(join(x, 'b', 'proj'), test.info().outputPath('l1'));

      return { cwd: join(test.info().outputPath('l1'), 'sub'), root };
    },
    expected: ranWith(callerUser(), { workdir: '/work/deep/proj/sub' }),
  },
  {
    name: 'no beadc.yaml',
    folders: () => {
      // ! outside the repository, whose root holds a beadc.yaml; by its long name, as Windows keeps
      // a short one in the temporary folder's path
      const folder = physicalOf(mkdtempSync(join(tmpdir(), 'beadc-no-yaml-')));

      return { cwd: folder, root: folder };
    },
    expected: ranWith(callerUser()),
  },
  {
    name: 'arguments with a space, an empty one, a quote, a backslash, &, % and ^',
    folders: atRoot,
    args: ARGUMENTS,
    expected: ranWith(callerUser(), { args: ARGUMENTS }),
  },
  {
    name: 'an engine stopped',
    folders: atRoot,
    env: { BEADC_PROBE_INFO: 'stopped' },
    expected: environmentFailure('docker does not answer: start it, then run beadc again', [
      ['--version'],
      ['info', '--format', DOCKER_FORMAT],
    ]),
  },
  {
    name: 'Windows containers',
    folders: atRoot,
    env: { BEADC_PROBE_INFO: 'windows ' },
    expected: environmentFailure('docker runs Windows containers: switch it to Linux containers', [
      ['--version'],
      ['info', '--format', DOCKER_FORMAT],
    ]),
  },
  {
    name: 'rootless Docker',
    folders: atRoot,
    env: { BEADC_PROBE_INFO: 'linux true' },
    expected: ranWith(['--user', '0:0']),
  },
  {
    name: 'rootless Podman',
    folders: atRoot,
    env: { BEADC_ENGINE: 'podman', BEADC_PROBE_INFO: 'linux true' },
    expected: ranWith(['--userns=keep-id'], { info: PODMAN_FORMAT }),
  },
  {
    name: 'rootful Podman',
    folders: atRoot,
    env: { BEADC_ENGINE: 'podman', BEADC_PROBE_INFO: 'linux false' },
    expected: ranWith(callerUser(), { info: PODMAN_FORMAT }),
  },
  {
    name: 'BEADC_ENGINE=Podman',
    folders: atRoot,
    env: { BEADC_ENGINE: 'Podman', BEADC_PROBE_INFO: 'linux true' },
    expected: ranWith(['--userns=keep-id'], { info: PODMAN_FORMAT }),
  },
  {
    name: 'a docker that reports podman version',
    folders: atRoot,
    env: { BEADC_PROBE_VERSION: 'podman version 5.6.0', BEADC_PROBE_INFO: 'linux true' },
    expected: ranWith(['--userns=keep-id'], { info: PODMAN_FORMAT }),
  },
  {
    name: "beadc's 1 passed",
    folders: atRoot,
    env: { BEADC_PROBE_EXIT: '1' },
    expected: ranWith(callerUser()),
  },
  {
    name: "the engine's 125 made 3",
    folders: atRoot,
    env: { BEADC_PROBE_EXIT: '125' },
    expected: (folders) => {
      return {
        ...ranWith(callerUser())(folders),
        stderr: `${STAND_IN_STDERR}beadc: docker could not run ${STAND_IN_IMAGE} (exit 125)\n`,
        status: 3,
      };
    },
  },
  {
    name: '130 passed',
    folders: atRoot,
    env: { BEADC_PROBE_EXIT: '130' },
    expected: (folders) => {
      return { ...ranWith(callerUser())(folders), status: 130 };
    },
  },
  {
    name: '143 passed',
    folders: atRoot,
    env: { BEADC_PROBE_EXIT: '143' },
    expected: (folders) => {
      return { ...ranWith(callerUser())(folders), status: 143 };
    },
  },
  {
    name: 'no engine',
    folders: atRoot,
    env: { BEADC_ENGINE: 'beadc-no-such-engine' },
    expected: environmentFailure(
      'no beadc-no-such-engine on the path: install Docker, or name another engine by BEADC_ENGINE',
      []
    ),
  },
];

test('the wrappers are ASCII and LF, and name one image, the version wrapper and init write', () => {
  const version = beadcVersion();
  const folder = test.info().outputPath('project');

  mkdirSync(folder, { recursive: true });
  initProject('hello', { folder, version });

  for (const name of WRAPPERS) {
    const template = readFileSync(join(TEMPLATES, name));
    const text = wrapperText(name, { version });

    expect(
      template.every((byte) => {
        return byte < 0x80;
      }),
      `${name} is ASCII`
    ).toBe(true);
    expect(template.includes('\r'), `${name} ends each line LF`).toBe(false);
    expect(template.toString('utf8').split(`${IMAGE}:@BEADC_VERSION@`)).toHaveLength(2);
    expect(text.split(`${IMAGE}:${version}`)).toHaveLength(2);
    expect(text).not.toContain('@BEADC_VERSION@');
    expect(readFileSync(join(folder, name), 'utf8')).toBe(text);
  }
});

test('wrapper prints the filled template, LF, and refuses another name with exit 2', () => {
  for (const name of WRAPPERS) {
    const run = spawnSync(process.execPath, [CLI, 'wrapper', name], { encoding: 'utf8' });

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(wrapperText(name, { version: beadcVersion() }));
  }

  for (const args of [
    ['wrapper'],
    ['wrapper', 'beadc.bat'],
    ['wrapper', 'beadc.sh', '--language', 'csharp'],
  ]) {
    const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

    expect(run.status, args.join(' ')).toBe(2);
    expect(run.stdout).toBe('');
  }
});

for (const each of CASES) {
  test(`each wrapper makes the same engine calls, prints the same bytes and exits alike: ${each.name}`, () => {
    test.skip(
      (each.on === 'windows' && !WINDOWS) || (each.on === 'posix' && WINDOWS),
      `a case of ${each.on ?? ''} hosts`
    );
    test.setTimeout(60_000);

    const bash = needsShells();
    const folders = each.folders();
    const ran = sameOf(
      runEach({
        cwd: folders.cwd,
        args: each.args ?? ['version'],
        bash,
        ...(each.env === undefined ? {} : { env: each.env }),
      })
    );
    const expected = each.expected(folders);

    expect(ran.status).toBe(expected.status);

    if (expected.stdout !== undefined) {
      expect(ran.stdout).toBe(expected.stdout);
    }

    if (expected.stderr !== undefined) {
      expect(ran.stderr).toBe(expected.stderr);
    }

    if (expected.calls !== undefined) {
      expect(ran.calls).toEqual(expected.calls);
    }

    if (expected.run !== undefined) {
      expect(ran.calls).toHaveLength(3);
      expect(ran.calls[0]).toEqual(['--version']);
      expect(ran.calls[1]).toEqual(['info', '--format', expected.info ?? DOCKER_FORMAT]);
      expect(ran.calls[2]).toEqual(expected.run);
    }
  });
}

test("in a session, beadc.ps1 passes the engine's UTF-8 whole, and a > on Windows writes its lines CRLF", () => {
  test.setTimeout(60_000);

  const bash = needsShells();
  const { cwd } = atRoot();
  const each = runEach({ cwd, args: ['version'], bash });
  const session = each.get(Way.PWSH_SESSION);

  expect(each.get(Way.BASH)?.stdout).toBe(STAND_IN_STDOUT);
  expect(each.get(Way.PWSH_FILE)?.stdout).toBe(STAND_IN_STDOUT);
  expect(each.get(Way.PWSH_FILE)?.stderr).toBe(STAND_IN_STDERR);

  // ! PowerShell's own >, which writes each line it reads with the platform's line end
  const crlf = (text: string): string => {
    return WINDOWS ? text.replaceAll('\n', '\r\n') : text;
  };

  expect(session?.stdout).toBe(crlf(STAND_IN_STDOUT));
  expect(session?.stderr).toBe(crlf(STAND_IN_STDERR));
});

test("in a session, a bare -- does not reach the engine, and a quoted '--' does", () => {
  test.setTimeout(60_000);

  const bash = needsShells();
  const { cwd } = atRoot();
  const env = {
    [PATH_NAME]: `${standInOf()}${delimiter}${process.env[PATH_NAME] ?? ''}`,
    BEADC_IMAGE: STAND_IN_IMAGE,
    BEADC_ENGINE: undefined,
  };
  const argsOf = (run: IRun): readonly string[] => {
    return (run.calls[2] ?? []).slice((run.calls[2] ?? []).indexOf(STAND_IN_IMAGE) + 1);
  };
  const args = ['check', '--', '-x'];

  expect(argsOf(runWay(Way.BASH, { cwd, args, env, bash }))).toEqual(args);
  expect(argsOf(runWay(Way.PWSH_FILE, { cwd, args, env, bash }))).toEqual(args);
  expect(
    argsOf(runWay(Way.PWSH_SESSION, { cwd, args, env, bash, tokens: ['check', '--', '-x'] }))
  ).toEqual(['check', '-x']);
  expect(
    argsOf(runWay(Way.PWSH_SESSION, { cwd, args, env, bash, tokens: ['check', "'--'", '-x'] }))
  ).toEqual(args);
});

test('a -name:value token reaches the engine split by pwsh -File and cut in a session; quoted, whole', () => {
  test.setTimeout(60_000);

  const bash = needsShells();
  const { cwd } = atRoot();
  const env = {
    [PATH_NAME]: `${standInOf()}${delimiter}${process.env[PATH_NAME] ?? ''}`,
    BEADC_IMAGE: STAND_IN_IMAGE,
    BEADC_ENGINE: undefined,
  };
  const argsOf = (run: IRun): readonly string[] => {
    return (run.calls[2] ?? []).slice((run.calls[2] ?? []).indexOf(STAND_IN_IMAGE) + 1);
  };
  const args = ['check', '--except:A', '-o:f'];

  expect(argsOf(runWay(Way.BASH, { cwd, args, env, bash }))).toEqual(args);
  expect(argsOf(runWay(Way.PWSH_FILE, { cwd, args, env, bash }))).toEqual([
    'check',
    '--except',
    'A',
    '-o',
    'f',
  ]);
  expect(
    argsOf(
      runWay(Way.PWSH_SESSION, { cwd, args, env, bash, tokens: ['check', '--except:A', '-o:f'] })
    )
  ).toEqual(['check', '--except:A', 'f']);
  expect(
    argsOf(
      runWay(Way.PWSH_SESSION, {
        cwd,
        args,
        env,
        bash,
        tokens: ['check', "'--except:A'", "'-o:f'"],
      })
    )
  ).toEqual(args);

  // beadc's own forms pass alike every way
  for (const way of WAYS) {
    expect(
      argsOf(runWay(way, { cwd, args: ['check', '--except=A', '--except', 'B'], env, bash })),
      way
    ).toEqual(['check', '--except=A', '--except', 'B']);
  }
});

test('each wrapper refuses the shell it is not written for, exit 3', () => {
  test.setTimeout(60_000);
  needsShells();

  const { cwd } = atRoot();
  const sh = spawnSync('sh', ['-c', 'printf %s "${BASH_VERSION:-}"'], { encoding: 'utf8' });
  const shIsBash = sh.status !== 0 || sh.stdout !== '';
  const windowsPowerShell = WINDOWS && spawnSync('powershell', ['-Help']).status !== null;

  test.skip(shIsBash && !windowsPowerShell, 'sh is bash here, and no Windows PowerShell runs');

  if (!shIsBash) {
    const run = spawnSync('sh', [filled('beadc.sh'), 'version'], { cwd, encoding: 'utf8' });

    expect(run.stderr).toBe('beadc: run beadc.sh with bash, not sh: ./beadc.sh or bash beadc.sh\n');
    expect(run.status).toBe(3);
  }

  if (windowsPowerShell) {
    const run = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        filled('beadc.ps1'),
        'version',
      ],
      { cwd, encoding: 'utf8' }
    );

    expect(run.stderr).toMatch(
      /^beadc: run beadc\.ps1 with PowerShell 7\.6 or later, pwsh, not 5\.1\./u
    );
    expect(run.status).toBe(3);
  }
});

test('an execution policy that refuses beadc.ps1 stops PowerShell before its first line, exit 1', () => {
  test.skip(!WINDOWS, 'an execution policy is Windows PowerShell and pwsh on Windows');
  test.setTimeout(60_000);
  needsShells();

  const { cwd } = atRoot();
  const env = environmentWith({
    [PATH_NAME]: `${standInOf()}${delimiter}${process.env[PATH_NAME] ?? ''}`,
    BEADC_IMAGE: STAND_IN_IMAGE,
    BEADC_ENGINE: undefined,
    BEADC_PROBE_LOG: test.info().outputPath('calls.log'),
  });

  for (const [shell, policy] of [
    ['pwsh', 'AllSigned'],
    ['powershell', 'Restricted'],
  ] as const) {
    const run = spawnSync(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        policy,
        '-File',
        filled('beadc.ps1'),
        'version',
      ],
      { cwd, env, encoding: 'utf8' }
    );

    expect(run.status, `${shell} under ${policy}`).toBe(1);
    expect(run.stdout + run.stderr).not.toContain('beadc:');
    expect(run.stdout + run.stderr).toContain('beadc.ps1');
  }

  expect(callsOf(test.info().outputPath('calls.log'))).toEqual([]);
});

test('beadc.ps1 refuses a folder whose name holds a backslash, exit 3, where beadc.sh runs', () => {
  test.skip(WINDOWS, 'a backslash is a separator on Windows: no folder holds one in its name');
  test.setTimeout(60_000);

  const bash = needsShells();
  const root = projectOf('back\\slash', '.');
  const env = {
    [PATH_NAME]: `${standInOf()}${delimiter}${process.env[PATH_NAME] ?? ''}`,
    BEADC_IMAGE: STAND_IN_IMAGE,
    BEADC_ENGINE: undefined,
  };
  const sh = runWay(Way.BASH, { cwd: root, args: ['version'], env, bash });
  const ps1 = runWay(Way.PWSH_FILE, { cwd: root, args: ['version'], env, bash });

  expect(sh.status).toBe(1);
  expect(sh.calls[2]).toEqual(
    runCall({ user: callerUser(), source: physicalOf(root), workdir: '/work', args: ['version'] })
  );
  expect(ps1.stderr).toBe(
    'beadc: PowerShell cannot run in a folder whose path holds a backslash: run beadc.sh\n'
  );
  expect(ps1.status).toBe(3);
});

// ── Through the image ─────────────────────────────────────────────────────────

// the image's run of a wrapper `way`, the engine the path's: BEADC_IMAGE names the image
const imageRunOf = (
  way: Way,
  options: { readonly cwd: string; readonly args: readonly string[]; readonly bash: string }
): IRun => {
  return parityOf(runWay(way, { ...options, env: { BEADC_ENGINE: undefined } }));
};

test("each wrapper runs beadc version through the image: protoc 36.2 and the spec's version", () => {
  test.setTimeout(120_000);

  const bash = needsShells();

  needsImage();

  const runs = WAYS.map((way) => {
    return imageRunOf(way, { cwd: REPOSITORY, args: ['version'], bash });
  });

  for (const run of runs) {
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`beadc ${beadcVersion()}\n`);
    expect(run.stdout).toContain(`\nprotoc ${protocPin().version}\n`);
    expect(run.stdout).toContain(`\nspec ${specVersion()}\n`);
    expect(run.stdout).toBe(runs[0]?.stdout);
  }
});

test("each wrapper runs generate --check over the repository's beadc.yaml through the image, 0, and 1 on a file off what beadc writes", () => {
  // four container starts and more, at about 1.5 s each, longer on a cold runner
  test.setTimeout(240_000);

  const bash = needsShells();

  needsImage();

  for (const cwd of [REPOSITORY, join(REPOSITORY, 'implementations', 'typescript')]) {
    for (const way of WAYS) {
      expect(
        imageRunOf(way, { cwd, args: ['generate', '--check'], bash }),
        `${way} from ${cwd}`
      ).toEqual({
        calls: [],
        stdout: '',
        stderr: '',
        status: 0,
      });
    }
  }

  // a copy of the repository's project, a file of it off what beadc writes
  const copy = test.info().outputPath('repository');
  const generated = 'implementations/typescript/interop/generated/interop_bead.ts';

  for (const path of [
    'beadc.yaml',
    'spec/interop-blueprint.json',
    'implementations/typescript/interop/generated',
    'implementations/dotnet/interop/Bead.Interop/Generated',
  ]) {
    cpSync(join(REPOSITORY, path), join(copy, path), { recursive: true });
  }

  writeFileSync(
    join(copy, generated),
    readFileSync(join(copy, generated), 'utf8').replace('Do not edit', 'Edit')
  );

  const off = WAYS.map((way) => {
    return imageRunOf(way, { cwd: copy, args: ['generate', '--check'], bash });
  });

  for (const run of off) {
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(`${generated}:2: line 2 differs from what beadc generate writes\n`);
    expect(run).toEqual(off[0]);
  }
});

// every file under `folder`, by its path from it, with slashes
const filesOf = (folder: string, under = folder): string[] => {
  return readdirSync(under, { withFileTypes: true }).flatMap((entry) => {
    const path = join(under, entry.name);

    return entry.isDirectory()
      ? filesOf(folder, path)
      : [relative(folder, path).replaceAll('\\', '/')];
  });
};

test("each wrapper generates the messages fixture in both languages through the image, protoc's C# among it, and beadc on Node finds nothing to change", () => {
  test.setTimeout(240_000);

  const bash = needsShells();

  needsImage();
  needsProtoc();

  const projects = [Way.BASH, Way.PWSH_FILE].map((way) => {
    const folder = test.info().outputPath(`messages-${way === Way.BASH ? 'sh' : 'ps1'}`);

    mkdirSync(folder, { recursive: true });
    cpSync(MESSAGES, join(folder, 'proto'), { recursive: true });
    writeFileSync(
      join(folder, 'beadc.yaml'),
      [
        'version: 1',
        'source:',
        '  proto: [proto]',
        'blueprint: gen/messages.blueprint.json',
        'outputs:',
        '  - language: typescript',
        '    out: gen/typescript',
        '  - language: csharp',
        '    out: gen/csharp',
        '',
      ].join('\n')
    );

    expect(imageRunOf(way, { cwd: folder, args: ['generate'], bash }), way).toEqual({
      calls: [],
      stdout: '',
      stderr: '',
      status: 0,
    });

    return folder;
  });

  const [first = '', second = ''] = projects;
  const files = filesOf(join(first, 'gen'));

  expect(files).toContain('csharp/Bead/Messages/V1/Messages.cs');
  expect(files).toContain('typescript/bead/messages/v1/messages_pb.ts');
  expect(filesOf(join(second, 'gen'))).toEqual(files);

  for (const folder of projects) {
    const check = spawnSync(process.execPath, [CLI, 'generate', '--check'], {
      cwd: folder,
      encoding: 'utf8',
    });

    expect(check.stdout + check.stderr).toBe('');
    expect(check.status).toBe(0);

    for (const file of files) {
      expect(readFileSync(join(folder, 'gen', file), 'utf8'), file).toBe(
        readFileSync(join(first, 'gen', file), 'utf8')
      );
    }
  }
});

test("each wrapper writes a project's files as the caller", () => {
  test.setTimeout(240_000);

  const bash = needsShells();
  const image = needsImage();

  for (const way of [Way.BASH, Way.PWSH_FILE]) {
    const name: WrapperName = way === Way.BASH ? 'beadc.sh' : 'beadc.ps1';
    const folder = test.info().outputPath(`caller-${name}`);

    mkdirSync(folder, { recursive: true });

    // * the first run, as builder/README.md gives it: the wrapper the image prints, written by the
    // shell's own >, then init and generate through it
    const printed =
      way === Way.BASH
        ? spawnSync(bash, ['-c', `docker run --rm "$1" wrapper ${name} > ${name}`, 'bash', image], {
            cwd: folder,
            encoding: 'utf8',
          })
        : spawnSync(
            'pwsh',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `docker run --rm ${quoted(image)} wrapper ${name} > ${name}; exit $LASTEXITCODE`,
            ],
            { cwd: folder, encoding: 'utf8' }
          );

    expect(printed.stderr).toBe('');
    expect(printed.status).toBe(0);
    expect(readFileSync(join(folder, name), 'utf8')).toBe(
      wrapperText(name, { version: beadcVersion() })
    );

    const through = (args: readonly string[]): { status: number | null; stdout: string } => {
      const run =
        way === Way.BASH
          ? spawnSync(bash, [join(folder, name), ...args], { cwd: folder, encoding: 'utf8' })
          : spawnSync(
              'pwsh',
              ['-NoProfile', '-NonInteractive', '-File', join(folder, name), ...args],
              { cwd: folder, encoding: 'utf8' }
            );

      expect(run.stderr, args.join(' ')).toBe('');

      return { status: run.status, stdout: run.stdout };
    };
    const init = through(['init', 'hello']);

    expect(init.status).toBe(0);
    expect(init.stdout).toContain(`kept ${name}, beadc's own
`);
    expect(through(['generate']).status).toBe(0);

    const files = filesOf(folder);

    expect(files).toContain('typescript/gen/hello/v1/hello_bead.ts');

    // ! Docker Desktop maps every user to the caller on Windows, which holds no owner's id
    if (!WINDOWS) {
      for (const file of files) {
        const stat = statSync(join(folder, file));

        expect({ file, uid: stat.uid, gid: stat.gid }).toEqual({
          file,
          uid: process.getuid?.(),
          gid: process.getgid?.(),
        });
      }

      expect(statSync(join(folder, 'beadc.sh')).mode & 0o777).toBe(0o755);
    }
  }
});

test("an interrupt ends a run under the wrappers' flags with 130", async () => {
  test.skip(WINDOWS, "a signal to the engine is a POSIX host's");
  test.setTimeout(60_000);

  const bash = needsShells();
  const image = needsImage();
  const { cwd } = atRoot();

  // the run's flags as the stand-in recorded them, node waiting in place of beadc
  const recorded =
    runWay(Way.BASH, {
      cwd,
      args: ['version'],
      env: {
        [PATH_NAME]: `${standInOf()}${delimiter}${process.env[PATH_NAME] ?? ''}`,
        BEADC_IMAGE: STAND_IN_IMAGE,
        BEADC_ENGINE: undefined,
      },
      bash,
    }).calls[2] ?? [];
  const flags = recorded.slice(1, recorded.indexOf(STAND_IN_IMAGE));
  const engine = spawn(
    'docker',
    [
      'run',
      ...flags,
      '--entrypoint',
      'node',
      image,
      '-e',
      "console.log('ready'); setTimeout(() => {}, 20000);",
    ],
    { cwd, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const exit = new Promise<number | null>((resolve) => {
    engine.on('exit', (code) => {
      resolve(code);
    });
  });

  engine.stdout.on('data', (data: Buffer) => {
    if (data.toString('utf8').includes('ready')) {
      engine.kill('SIGINT');
    }
  });

  expect(flags).toContain('--init');
  expect(await exit).toBe(130);
});
