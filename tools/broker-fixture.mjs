// What every broker fixture of the run holds that is no broker's own (decisions 0041 and 0043): a
// container of the run's own, under a name drawn for it and on loopback ports Docker gives, a
// password drawn for the run, the run's folder in its temporary folder (TMP), and the command line
// each fixture offers, `tools/mqtt-broker.mjs` and `tools/amqp-broker.mjs` alike:
//
//   node tools/<broker>-broker.mjs start [--github-env]
//   node tools/<broker>-broker.mjs stop [<broker>]
//   node tools/<broker>-broker.mjs run -- <command…>
//
// start prints the broker's variables, BEAD_<BROKER>_URL, BEAD_<BROKER>_PASSWORD and
// BEAD_<BROKER>_BROKER among them, as PowerShell's `$env:` lines, or, with --github-env, appends them
// to $GITHUB_ENV, the password masked first. stop removes that broker and its folder,
// BEAD_<BROKER>_BROKER's by default. run starts a broker, runs the command with those variables set,
// and stops the broker whatever the command's end, its exit code the command's. Exit 1 on a broker
// that does not come up, 2 on a usage error.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

// the interop's participants and the names each serves or calls, over every broker (spec 15.31,
// 15.38): a server reads its own name and the one both serve in a group, a client writes each
export const INTEROP = Object.freeze({
  servers: Object.freeze({
    'ts-server': ['interop-ts', 'interop-both'],
    'cs-server': ['interop-cs', 'interop-both'],
  }),
  clients: Object.freeze(['ts-client', 'cs-client']),
  names: Object.freeze(['interop-ts', 'interop-cs', 'interop-both']),
});

// the user a start links as to see its broker up, granted nothing a participant is
export const READINESS_USER = 'fixture';

// what spec/transports.json describes, the brokers the cases play against among it
export const transportsDocument = () => {
  return JSON.parse(readFileSync(join(ROOT, 'spec', 'transports.json'), 'utf8'));
};

export const pause = (milliseconds) => {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
};

// a password for the run, which every user of its broker authenticates with
export const drawPassword = () => {
  return randomBytes(24).toString('hex');
};

// ── Docker ────────────────────────────────────────────────────────────────────

export const docker = (args, options = {}) => {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
};

// the container name a broker's start draws, and the pattern of every one it could draw
export const containerNameOf = (broker) => {
  return `bead-${broker}-${randomBytes(4).toString('hex')}`;
};

export const isContainerOf = (broker, name) => {
  return new RegExp(`^bead-${broker}-[0-9a-f]{8}$`).test(name);
};

// the label a container keeps its folder under, so that stop removes both
const labelOf = (broker) => {
  return `bead.${broker}.folder`;
};

// the image by its digest, pulled where this machine holds none
export const pullImage = (image) => {
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    process.stderr.write(`pulling ${image}\n`);
    execFileSync('docker', ['pull', image], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
};

// the host port Docker gave a container's port, on the loopback
export const hostPortOf = (name, port) => {
  const found = /127\.0\.0\.1:(\d+)/.exec(docker(['port', name, `${port}/tcp`]));

  if (found === null) {
    throw new Error(`docker gave ${name}'s port ${port} no port on 127.0.0.1`);
  }

  return Number(found[1]);
};

// a broker's container, detached, each of its ports published on a loopback port Docker draws, and
// those ports read back: the run's arguments go before the image, its command after it
export const runContainer = (broker, { name, folder, image, ports, args = [], command = [] }) => {
  docker([
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `${labelOf(broker)}=${folder}`,
    ...ports.flatMap((port) => {
      return ['--publish', `127.0.0.1::${port}`];
    }),
    ...args,
    image,
    ...command,
  ]);

  try {
    return Object.fromEntries(
      ports.map((port) => {
        return [port, hostPortOf(name, port)];
      })
    );
  } catch (error) {
    // ! a container whose ports could not be read is still up, under its name alone
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    throw error;
  }
};

// a container removed, and the folder its label names
export const removeContainer = (broker, name) => {
  const inspected = spawnSync(
    'docker',
    ['inspect', '--format', `{{ index .Config.Labels "${labelOf(broker)}" }}`, name],
    { encoding: 'utf8' }
  );
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
  const folder = inspected.status === 0 ? inspected.stdout.trim() : '';

  if (folder !== '') {
    rmSync(folder, { recursive: true, force: true });
  }
};

// what a container logged last, for a broker that did not come up
export const logsOf = (name) => {
  const logs = spawnSync('docker', ['logs', '--tail', '50', name], { encoding: 'utf8' });
  return `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
};

// ── The run's folder ──────────────────────────────────────────────────────────

// the folder of every broker of one kind's files, in the run's temporary folder
export const foldersOf = (broker) => {
  return join(tmpdir(), `bead-${broker}`);
};

// a folder of one broker's own
export const folderFor = (broker) => {
  const folder = join(foldersOf(broker), randomBytes(4).toString('hex'));
  mkdirSync(folder, { recursive: true });
  return folder;
};

// ── The command line ──────────────────────────────────────────────────────────

// what the command line asks, or the reason it is no usage: `brokers` the names stop takes, and
// `options` the broker's own, each taking a value, on start and run alone
export const parseCommand = (args, { brokers, options = [] }) => {
  const [action, ...rest] = args;
  const separator = rest.indexOf('--');
  const own = separator === -1 ? rest : rest.slice(0, separator);
  const command = separator === -1 ? [] : rest.slice(separator + 1);
  const parsed = { action, githubEnv: false };

  for (const option of options) {
    parsed[option.slice(2)] = undefined;
  }

  parsed.broker = undefined;
  parsed.command = command;

  for (let at = 0; at < own.length; at += 1) {
    if (options.includes(own[at]) && at + 1 < own.length && action !== 'stop') {
      parsed[own[at].slice(2)] = own[at + 1];
      at += 1;
    } else if (own[at] === '--github-env' && action === 'start') {
      parsed.githubEnv = true;
    } else if (action === 'stop' && parsed.broker === undefined && brokers.test(own[at])) {
      parsed.broker = own[at];
    } else {
      return { problem: `${own[at]} is no option of ${action}` };
    }
  }

  if (!['start', 'stop', 'run'].includes(action)) {
    return { problem: action === undefined ? 'no action given' : `${action} is no action` };
  }

  if (action === 'run' && command.length === 0) {
    return { problem: 'run takes its command after --' };
  }

  if (action !== 'run' && separator !== -1) {
    return { problem: `${action} takes no command` };
  }

  return parsed;
};

// a value PowerShell reads back as it is, between single quotes
export const powerShellQuoted = (value) => {
  return `'${value.replaceAll("'", "''")}'`;
};

// a command's words as a shell reads them back, for a command a .cmd may run on Windows
export const commandLineOf = (words) => {
  return words
    .map((word) => {
      return /^[\w./:=@\\-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
    })
    .join(' ');
};

// a fixture's variables by their names: BEAD_<BROKER>_URL, _PASSWORD and _BROKER
const variablesOf = (broker) => {
  const prefix = `BEAD_${broker.toUpperCase()}`;
  return { url: `${prefix}_URL`, password: `${prefix}_PASSWORD`, broker: `${prefix}_BROKER` };
};

const runCommand = async (fixture, { parsed, stderr }) => {
  const names = variablesOf(fixture.broker);
  const variables = await fixture.start(parsed);
  stderr.write(`broker ${variables[names.broker]} at ${variables[names.url]}\n`);

  let stopped = false;

  const stopOnce = () => {
    if (!stopped) {
      stopped = true;
      fixture.stop(variables[names.broker]);
    }
  };

  // ! a broker left up keeps its participants' ids, which the next run's links would meet
  process.on('exit', stopOnce);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      // the command hears the signal too; the broker goes once it ended
    });
  }

  const [file, ...args] = parsed.command;
  const onWindows = process.platform === 'win32';
  const child = onWindows
    ? spawn(commandLineOf(parsed.command), {
        stdio: 'inherit',
        env: { ...process.env, ...variables },
        shell: true,
      })
    : spawn(file, args, { stdio: 'inherit', env: { ...process.env, ...variables } });

  const code = await new Promise((settle) => {
    child.on('error', (error) => {
      stderr.write(`${error.message}\n`);
      settle(127);
    });
    child.on('exit', (status, signal) => {
      // a command a signal ended exits as a shell reports it, 128 and the signal's number
      settle(status ?? 128 + (constants.signals[signal] ?? 0));
    });
  });

  stopOnce();
  return code;
};

// a fixture's command line run: `broker` its kind (mqtt, amqp), `usage` its lines, `brokers` the
// names stop takes, `options` its own, `start` the variables of a broker up, `stop` one removed; what
// it prints goes to the streams given, the process's own by default
export const fixtureMain = async (
  fixture,
  { args, stdout = process.stdout, stderr = process.stderr }
) => {
  const usage = fixture.usage.join('\n');
  const names = variablesOf(fixture.broker);
  const parsed = parseCommand(args, fixture);

  if (parsed.problem !== undefined) {
    stderr.write(`${parsed.problem}\n${usage}\n`);
    return 2;
  }

  if (parsed.action === 'run') {
    return runCommand(fixture, { parsed, stderr });
  }

  if (parsed.action === 'stop') {
    const broker = parsed.broker ?? process.env[names.broker];

    if (broker === undefined || !fixture.brokers.test(broker)) {
      stderr.write(`no broker named, and ${names.broker} names none\n${usage}\n`);
      return 2;
    }

    fixture.stop(broker);
    return 0;
  }

  if (parsed.githubEnv && process.env.GITHUB_ENV === undefined) {
    stderr.write(`--github-env, and GITHUB_ENV names no file\n${usage}\n`);
    return 2;
  }

  const variables = await fixture.start(parsed);

  if (parsed.githubEnv) {
    // ! the mask before any line that could print the password
    stdout.write(`::add-mask::${variables[names.password]}\n`);
    appendFileSync(
      process.env.GITHUB_ENV,
      Object.entries(variables)
        .map(([name, value]) => {
          return `${name}=${value}\n`;
        })
        .join('')
    );
    stdout.write(`broker ${variables[names.broker]} at ${variables[names.url]}\n`);
    return 0;
  }

  for (const [name, value] of Object.entries(variables)) {
    stdout.write(`$env:${name} = ${powerShellQuoted(value)}\n`);
  }

  return 0;
};

// a fixture's command line, run as its script's main: its exit code the command's, 1 on a broker
// that did not come up
export const runFixture = (fixture) => {
  fixtureMain(fixture, { args: process.argv.slice(2) }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
};
