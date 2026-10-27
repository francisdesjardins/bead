import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  INTEROP,
  READINESS_USER,
  commandLineOf,
  containerNameOf,
  drawPassword,
  fixtureMain,
  folderFor,
  foldersOf,
  isContainerOf,
  parseCommand,
  powerShellQuoted,
} from '../broker-fixture.mjs';

// a fixture of no broker, which records what it was asked
const fakeOf = () => {
  const asked = { starts: [], stops: [] };

  return {
    asked,
    fixture: {
      broker: 'fake',
      usage: ['usage: fake'],
      brokers: /^bead-fake-[0-9a-f]{8}$/,
      options: [],
      start: async (parsed) => {
        asked.starts.push(parsed);
        return {
          BEAD_FAKE_URL: 'fake://127.0.0.1:1',
          BEAD_FAKE_PASSWORD: 'secret',
          BEAD_FAKE_BROKER: 'bead-fake-0a1b2c3d',
        };
      },
      stop: (broker) => {
        asked.stops.push(broker);
      },
    },
  };
};

// a fixture's command line run, what it printed kept
const mainOf = async (fixture, args) => {
  const output = { stdout: '', stderr: '' };
  const streamOf = (name) => {
    return {
      write: (chunk) => {
        output[name] += String(chunk);
        return true;
      },
    };
  };
  const result = await fixtureMain(fixture, {
    args,
    stdout: streamOf('stdout'),
    stderr: streamOf('stderr'),
  });
  return { result, ...output };
};

describe('the run’s own broker', () => {
  test('draws a container name of its kind, which no other kind takes for its own', () => {
    const name = containerNameOf('amqp');

    assert.match(name, /^bead-amqp-[0-9a-f]{8}$/);
    assert.ok(isContainerOf('amqp', name));
    assert.ok(!isContainerOf('mqtt', name));
    assert.notEqual(containerNameOf('amqp'), name);
  });

  test('draws a password of 48 hexadecimal digits for each run', () => {
    assert.match(drawPassword(), /^[0-9a-f]{48}$/);
    assert.notEqual(drawPassword(), drawPassword());
  });

  test('keeps its files in a folder of its own, in the run’s temporary folder', () => {
    const folder = folderFor('fake');

    try {
      assert.ok(existsSync(folder));
      assert.equal(dirname(folder), foldersOf('fake'));
      assert.equal(dirname(foldersOf('fake')), resolve(tmpdir()));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('names the interop’s participants and the readiness check’s user, the same over every broker', () => {
    assert.deepEqual(Object.keys(INTEROP.servers), ['ts-server', 'cs-server']);
    assert.deepEqual(INTEROP.clients, ['ts-client', 'cs-client']);
    assert.deepEqual(INTEROP.names, ['interop-ts', 'interop-cs', 'interop-both']);
    assert.equal(READINESS_USER, 'fixture');
  });
});

describe('the command line', () => {
  test('takes start, stop and run, a broker’s own options on start and run alone', () => {
    const brokers = /^bead-fake-[0-9a-f]{8}$/;

    assert.deepEqual(parseCommand(['start', '--github-env'], { brokers }), {
      action: 'start',
      githubEnv: true,
      broker: undefined,
      command: [],
    });
    assert.deepEqual(
      parseCommand(['run', '--native', 'C:/m', '--', 'x'], { brokers, options: ['--native'] }),
      {
        action: 'run',
        githubEnv: false,
        native: 'C:/m',
        broker: undefined,
        command: ['x'],
      }
    );
    assert.match(
      parseCommand(['stop', '--native', 'C:/m'], { brokers, options: ['--native'] }).problem,
      /--native/
    );
    assert.match(
      parseCommand(['run', '--native', 'C:/m', '--', 'x'], { brokers }).problem,
      /--native/
    );
    assert.match(parseCommand(['restart'], { brokers }).problem, /restart is no action/);
  });

  test('quotes a value as PowerShell reads it back, and a command’s words as a shell does', () => {
    assert.equal(powerShellQuoted("it's"), "'it''s'");
    assert.equal(commandLineOf(['yarn', 'test:amqp']), 'yarn test:amqp');
    assert.equal(commandLineOf(['node', '-e', 'a "b"']), 'node -e "a \\"b\\""');
  });

  test('prints a started broker’s variables as PowerShell’s lines', async () => {
    const { asked, fixture } = fakeOf();
    const { result, stdout } = await mainOf(fixture, ['start']);

    assert.equal(result, 0);
    assert.equal(asked.starts.length, 1);
    assert.deepEqual(stdout.trim().split('\n'), [
      "$env:BEAD_FAKE_URL = 'fake://127.0.0.1:1'",
      "$env:BEAD_FAKE_PASSWORD = 'secret'",
      "$env:BEAD_FAKE_BROKER = 'bead-fake-0a1b2c3d'",
    ]);
  });

  test('appends them to GITHUB_ENV with --github-env, the password masked before any of them', async () => {
    const { fixture } = fakeOf();
    const folder = mkdtempSync(join(tmpdir(), 'bead-fixture-test-'));
    const file = join(folder, 'env');
    const previous = process.env.GITHUB_ENV;
    process.env.GITHUB_ENV = file;

    try {
      const { result, stdout } = await mainOf(fixture, ['start', '--github-env']);

      assert.equal(result, 0);
      assert.equal(stdout.split('\n')[0], '::add-mask::secret');
      assert.ok(!stdout.split('\n').slice(1).join('\n').includes('secret'));
      assert.equal(
        readFileSync(file, 'utf8'),
        'BEAD_FAKE_URL=fake://127.0.0.1:1\nBEAD_FAKE_PASSWORD=secret\nBEAD_FAKE_BROKER=bead-fake-0a1b2c3d\n'
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_ENV;
      } else {
        process.env.GITHUB_ENV = previous;
      }

      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('stops the broker named, or its variable’s, and refuses a stop that names none', async () => {
    const { asked, fixture } = fakeOf();
    const previous = process.env.BEAD_FAKE_BROKER;

    try {
      delete process.env.BEAD_FAKE_BROKER;
      const refused = await mainOf(fixture, ['stop']);

      assert.equal(refused.result, 2);
      assert.match(refused.stderr, /BEAD_FAKE_BROKER names none/);

      process.env.BEAD_FAKE_BROKER = 'bead-fake-00000000';
      assert.equal((await mainOf(fixture, ['stop'])).result, 0);
      assert.equal((await mainOf(fixture, ['stop', 'bead-fake-11111111'])).result, 0);
      assert.deepEqual(asked.stops, ['bead-fake-00000000', 'bead-fake-11111111']);
    } finally {
      if (previous === undefined) {
        delete process.env.BEAD_FAKE_BROKER;
      } else {
        process.env.BEAD_FAKE_BROKER = previous;
      }
    }
  });

  test('runs a command with the broker’s variables, stops the broker once it ended, and exits as it did', async () => {
    const { asked, fixture } = fakeOf();
    const { result } = await mainOf(fixture, [
      'run',
      '--',
      process.execPath,
      '-e',
      'process.exit(process.env.BEAD_FAKE_URL === `fake://127.0.0.1:1` ? 3 : 4)',
    ]);

    assert.equal(result, 3);
    assert.deepEqual(asked.stops, ['bead-fake-0a1b2c3d']);
  });

  test('refuses what is no usage with exit 2, naming it and its usage', async () => {
    const { asked, fixture } = fakeOf();
    const { result, stderr } = await mainOf(fixture, ['run']);

    assert.equal(result, 2);
    assert.match(stderr, /after --\nusage: fake/);
    assert.equal(asked.starts.length, 0);
  });
});
