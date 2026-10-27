#!/usr/bin/env node
// A Mosquitto 2.1.2 of the run's own, which every MQTT 5 case, adapter suite and interop leg plays
// against (spec 15.25 to 15.31, decision 0041): the broker `spec/transports.json`'s `brokers.mqtt`
// describes, its access control 15.31's for the cases' users and the interop's, a password drawn for
// the run, under a container name and loopback ports of its own, so that two runs on one machine
// share no broker. Docker runs the image by its digest; a native Mosquitto runs where `--native`
// names its folder.
//
//   node tools/mqtt-broker.mjs start [--native <folder>] [--github-env]
//   node tools/mqtt-broker.mjs stop [<broker>]
//   node tools/mqtt-broker.mjs run [--native <folder>] -- <command…>
//
// start prints BEAD_MQTT_URL, BEAD_MQTT_WS_URL, BEAD_MQTT_PASSWORD and BEAD_MQTT_BROKER as
// PowerShell's `$env:` lines, or, with --github-env, appends them to $GITHUB_ENV, the password
// masked first. stop removes that broker and its folder, BEAD_MQTT_BROKER's by default. run starts a
// broker, runs the command with those variables set, and stops the broker whatever the command's
// end, its exit code the command's. Its files go to the run's temporary folder (TMP). Exit 1 on a
// broker that does not come up, 2 on a usage error.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ! the image by its digest alone: a tag names whatever was pushed under it last
export const IMAGE =
  'eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f';

// the ports Mosquitto listens on inside its container, MQTT over TCP and over a WebSocket
const MQTT_PORT = 1883;
const WEBSOCKET_PORT = 9001;

// the interop's participants and the names each serves or calls (spec 15.31): a server reads its
// own name and the one both serve in a group, a client writes each
export const INTEROP = Object.freeze({
  servers: Object.freeze({
    'ts-server': ['interop-ts', 'interop-both'],
    'cs-server': ['interop-cs', 'interop-both'],
  }),
  clients: Object.freeze(['ts-client', 'cs-client']),
  names: Object.freeze(['interop-ts', 'interop-cs', 'interop-both']),
});

// the user start links as to read its broker's CONNACK, granted nothing past 15.31's patterns
const READINESS_USER = 'fixture';

// how long a broker has to answer an authenticated CONNECT once it runs
const READY_WITHIN = 30_000;

// a broker's name, as start draws it: a container's, or a native process's id
const BROKER = /^(?:bead-mqtt-[0-9a-f]{8}|[0-9]+)$/;

// ── The broker's files ────────────────────────────────────────────────────────

// the broker the cases play against, as spec/transports.json describes it
export const brokerOf = (document) => {
  const broker = document?.brokers?.mqtt;

  if (
    broker === undefined ||
    !Array.isArray(broker.users) ||
    !Number.isInteger(broker.maximumPacketSize)
  ) {
    throw new Error(
      'spec/transports.json describes no brokers.mqtt, its users and its maximumPacketSize'
    );
  }

  return broker;
};

// every user the broker authenticates: the cases', the interop's and the readiness check's
export const usersOf = (broker) => {
  return [
    ...new Set([
      ...broker.users,
      ...Object.keys(INTEROP.servers),
      ...INTEROP.clients,
      READINESS_USER,
    ]),
  ];
};

// mosquitto.conf, its paths those the broker reads them from and its listeners on the ports given
export const configurationOf = (broker, { folder, mqttPort, webSocketPort, bind }) => {
  return [
    'allow_anonymous false',
    `password_file ${folder}/passwords`,
    `acl_file ${folder}/acl`,
    'persistence false',
    'log_dest stdout',
    'log_type error',
    'log_type warning',
    'log_type notice',
    'log_type information',
    // queues lifted, and no receive maximum toward a participant (spec 15.31)
    'max_queued_messages 0',
    'max_queued_bytes 0',
    'max_inflight_messages 0',
    'queue_qos0_messages false',
    `max_packet_size ${broker.maximumPacketSize}`,
    `retain_available ${broker.retainAvailable === false ? 'false' : 'true'}`,
    'set_tcp_nodelay true',
    '',
    `listener ${mqttPort} ${bind}`,
    'protocol mqtt',
    // ! the Client Identifier tied to the user the broker authenticated (spec 15.31)
    'use_username_as_clientid true',
    '',
    `listener ${webSocketPort} ${bind}`,
    'protocol websockets',
    'use_username_as_clientid true',
    '',
  ].join('\n');
};

// the access control of spec 15.31, by the id each link authenticated: a participant reads its own
// inbox and its will writes its own departure; every participant writes any inbox and reads any
// departure; each case's user reads and writes every name, so that a peer plays an acceptor; and
// the interop's servers read their names alone, on the names' own topics, its clients write them
export const aclOf = (broker) => {
  const lines = [
    'pattern read bead/i/%u',
    'pattern write bead/d/%u',
    'pattern write bead/i/+',
    'pattern read bead/d/+',
    '',
  ];

  for (const user of broker.users) {
    lines.push(`user ${user}`, 'topic readwrite bead/s/#', '');
  }

  for (const [user, names] of Object.entries(INTEROP.servers)) {
    lines.push(`user ${user}`, ...names.map((name) => `topic read bead/s/${name}`), '');
  }

  for (const user of INTEROP.clients) {
    lines.push(`user ${user}`, ...INTEROP.names.map((name) => `topic write bead/s/${name}`), '');
  }

  return lines.join('\n');
};

// ── MQTT 5, by hand ───────────────────────────────────────────────────────────

// a Variable Byte Integer (MQTT 5.0 §1.5.5)
export const variableByteInteger = (value) => {
  const bytes = [];
  let left = value;

  do {
    const byte = left % 128;
    left = Math.floor(left / 128);
    bytes.push(left > 0 ? byte | 0x80 : byte);
  } while (left > 0);

  return Buffer.from(bytes);
};

// a UTF-8 Encoded String or Binary Data: its length on two bytes, then its bytes (MQTT 5.0 §1.5.4)
const lengthPrefixed = (data) => {
  const bytes = Buffer.from(data);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

// an MQTT 5 CONNECT of Clean Start 1, its User Name and Password given, its Client Identifier the
// user's, its Keep Alive in seconds, and no property (MQTT 5.0 §3.1)
export const connectPacket = ({ user, password, keepAlive }) => {
  const keep = Buffer.alloc(2);
  keep.writeUInt16BE(keepAlive);
  const variable = Buffer.concat([
    lengthPrefixed('MQTT'),
    Buffer.from([5, 0xc2]),
    keep,
    Buffer.from([0]),
  ]);
  const payload = Buffer.concat([
    lengthPrefixed(user),
    lengthPrefixed(user),
    lengthPrefixed(password),
  ]);
  const rest = Buffer.concat([variable, payload]);
  return Buffer.concat([Buffer.from([0x10]), variableByteInteger(rest.length), rest]);
};

// a DISCONNECT of Reason Code 0x00, so that no will goes (MQTT 5.0 §3.14)
export const DISCONNECT = Buffer.from([0xe0, 0x00]);

// the Reason Code of the CONNACK at the head of what a broker sent: undefined while it is not whole,
// null where what came is no CONNACK (MQTT 5.0 §3.2)
export const connackReasonOf = (received) => {
  if (received.length < 2) {
    return undefined;
  }

  if (received[0] !== 0x20) {
    return null;
  }

  let length = 0;
  let at = 1;

  for (let multiplier = 1; ; multiplier *= 128, at += 1) {
    if (at >= received.length) {
      return undefined;
    }

    length += (received[at] & 0x7f) * multiplier;

    if ((received[at] & 0x80) === 0) {
      break;
    }

    if (at === 4) {
      return null;
    }
  }

  if (received.length < at + 1 + length) {
    return undefined;
  }

  return length >= 2 ? received[at + 2] : null;
};

// one authenticated CONNECT to the broker on that port, settled with its CONNACK's Reason Code, or
// null where no CONNACK came; a CONNACK of 0x00 is answered by a DISCONNECT of 0x00
const connackOf = (port, password) => {
  return new Promise((settle) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let received = Buffer.alloc(0);
    let settled = false;

    const end = (reason) => {
      if (settled) {
        return;
      }

      settled = true;

      if (reason === 0) {
        socket.end(DISCONNECT);
      } else {
        socket.destroy();
      }

      settle(reason);
    };

    socket.setTimeout(2_000, () => {
      end(null);
    });
    socket.on('connect', () => {
      socket.write(connectPacket({ user: READINESS_USER, password, keepAlive: 10 }));
    });
    socket.on('data', (data) => {
      received = Buffer.concat([received, data]);
      const reason = connackReasonOf(received);

      if (reason !== undefined) {
        end(reason);
      }
    });
    socket.on('error', () => {
      end(null);
    });
    socket.on('close', () => {
      end(null);
    });
  });
};

// whether the WebSocket listener on that port answers an upgrade of subprotocol mqtt with a 101
// (RFC 6455 §4.1, MQTT 5.0 §6)
const upgradeOf = (port) => {
  return new Promise((settle) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let received = '';

    const end = (upgraded) => {
      socket.destroy();
      settle(upgraded);
    };

    socket.setTimeout(2_000, () => {
      end(false);
    });
    socket.on('connect', () => {
      socket.write(
        `GET /mqtt HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
          'Sec-WebSocket-Protocol: mqtt\r\n\r\n'
      );
    });
    socket.on('data', (data) => {
      received += data.toString('latin1');

      if (received.includes('\r\n')) {
        end(/^HTTP\/1\.1 101 /.test(received));
      }
    });
    socket.on('error', () => {
      end(false);
    });
  });
};

const pause = (milliseconds) => {
  return new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
};

// ! an open port alone proves nothing: Docker's proxy takes a connection before Mosquitto listens,
// so the broker is up once it answers an authenticated CONNECT with CONNACK 0x00
const awaitReady = async ({ mqttPort, webSocketPort, password }) => {
  const deadline = Date.now() + READY_WITHIN;
  let reason = null;

  while (Date.now() < deadline) {
    reason = await connackOf(mqttPort, password);

    if (reason === 0 && (await upgradeOf(webSocketPort))) {
      return;
    }

    await pause(200);
  }

  throw new Error(
    reason === null
      ? `no broker answered a CONNECT on 127.0.0.1:${mqttPort} within ${READY_WITHIN / 1000} s`
      : `the broker answered its CONNECT with CONNACK 0x${reason.toString(16).padStart(2, '0')}`
  );
};

// ── Docker ────────────────────────────────────────────────────────────────────

const docker = (args, options = {}) => {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
};

// the host port Docker gave a container's port, on the loopback
const hostPortOf = (name, port) => {
  const found = /127\.0\.0\.1:(\d+)/.exec(docker(['port', name, `${port}/tcp`]));

  if (found === null) {
    throw new Error(`docker gave ${name}'s port ${port} no port on 127.0.0.1`);
  }

  return Number(found[1]);
};

// the script the container runs: its files copied out of the read-only mount and owned by
// mosquitto, each user's password hashed by the image's own mosquitto_passwd, then the broker
// ! a password file or an ACL its user cannot read stops Mosquitto, and a file of a bind mount from
// Windows keeps the host's owner whatever chown says, so the broker reads its own copies
const CONTAINER_SCRIPT = [
  'mkdir -p /mosquitto/config',
  'cp /bead/mosquitto.conf /bead/acl /mosquitto/config/',
  'password="$(cat /bead/password)"',
  'first=-c',
  'for user in $(cat /bead/users); do mosquitto_passwd $first -b /mosquitto/config/passwords "$user" "$password"; first=; done',
  'chown mosquitto:mosquitto /mosquitto/config/passwords /mosquitto/config/acl',
  'chmod 0600 /mosquitto/config/passwords /mosquitto/config/acl',
  'exec mosquitto -c /mosquitto/config/mosquitto.conf',
].join('\n');

const startInDocker = (broker, { folder, password }) => {
  const name = `bead-mqtt-${randomBytes(4).toString('hex')}`;
  const configuration = { mqttPort: MQTT_PORT, webSocketPort: WEBSOCKET_PORT, bind: '0.0.0.0' };

  writeFileSync(
    join(folder, 'mosquitto.conf'),
    configurationOf(broker, { folder: '/mosquitto/config', ...configuration })
  );
  writeFileSync(join(folder, 'acl'), aclOf(broker));
  writeFileSync(join(folder, 'users'), `${usersOf(broker).join('\n')}\n`);
  writeFileSync(join(folder, 'password'), password, { mode: 0o600 });

  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) {
    process.stderr.write(`pulling ${IMAGE}\n`);
    execFileSync('docker', ['pull', IMAGE], { stdio: ['ignore', 'ignore', 'inherit'] });
  }

  docker([
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `bead.mqtt.folder=${folder}`,
    '--publish',
    `127.0.0.1::${MQTT_PORT}`,
    '--publish',
    `127.0.0.1::${WEBSOCKET_PORT}`,
    '--mount',
    `type=bind,source=${folder},target=/bead,readonly`,
    '--entrypoint',
    'sh',
    IMAGE,
    '-ec',
    CONTAINER_SCRIPT,
  ]);

  try {
    return {
      broker: name,
      mqttPort: hostPortOf(name, MQTT_PORT),
      webSocketPort: hostPortOf(name, WEBSOCKET_PORT),
    };
  } catch (error) {
    // ! a container whose ports could not be read is still up, under its name alone
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    throw error;
  }
};

// ── Natively ──────────────────────────────────────────────────────────────────

// a port free on the loopback, as the system gives one
const freePort = () => {
  return new Promise((settle, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        settle(port);
      });
    });
  });
};

const executableIn = (native, name) => {
  const path = join(native, process.platform === 'win32' ? `${name}.exe` : name);

  if (!existsSync(path)) {
    throw new Error(
      `${path} is not there: --native names the folder Mosquitto 2.1.2 is installed in`
    );
  }

  return path;
};

const startNatively = async (broker, { folder, password, native }) => {
  const configuration = {
    mqttPort: await freePort(),
    webSocketPort: await freePort(),
    bind: '127.0.0.1',
  };
  const forward = folder.replaceAll('\\', '/');
  const passwords = join(folder, 'passwords');

  writeFileSync(
    join(folder, 'mosquitto.conf'),
    configurationOf(broker, { folder: forward, ...configuration })
  );
  writeFileSync(join(folder, 'acl'), aclOf(broker));

  usersOf(broker).forEach((user, index) => {
    execFileSync(
      executableIn(native, 'mosquitto_passwd'),
      [...(index === 0 ? ['-c'] : []), '-b', passwords, user, password],
      {
        stdio: 'ignore',
      }
    );
  });

  const child = spawn(executableIn(native, 'mosquitto'), ['-c', join(folder, 'mosquitto.conf')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  writeFileSync(join(folder, 'broker.pid'), String(child.pid));

  return {
    broker: String(child.pid),
    mqttPort: configuration.mqttPort,
    webSocketPort: configuration.webSocketPort,
  };
};

// ── Start and stop ────────────────────────────────────────────────────────────

// the folder of a broker's files, in the run's temporary folder
const FOLDERS = 'bead-mqtt';

const folderFor = () => {
  const folder = join(tmpdir(), FOLDERS, randomBytes(4).toString('hex'));
  mkdirSync(folder, { recursive: true });
  return folder;
};

// a broker of the run's own, up: its variables, the URLs its clients link to
export const start = async ({ native } = {}) => {
  const broker = brokerOf(JSON.parse(readFileSync(join(ROOT, 'spec', 'transports.json'), 'utf8')));
  const password = randomBytes(24).toString('hex');
  const folder = folderFor();
  let started;

  try {
    started =
      native === undefined
        ? startInDocker(broker, { folder, password })
        : await startNatively(broker, { folder, password, native });
    await awaitReady({ ...started, password });
  } catch (error) {
    if (started !== undefined) {
      process.stderr.write(logsOf(started.broker));
      stop(started.broker);
    } else {
      rmSync(folder, { recursive: true, force: true });
    }

    throw error;
  }

  return {
    BEAD_MQTT_URL: `mqtt://127.0.0.1:${started.mqttPort}`,
    BEAD_MQTT_WS_URL: `ws://127.0.0.1:${started.webSocketPort}/mqtt`,
    BEAD_MQTT_PASSWORD: password,
    BEAD_MQTT_BROKER: started.broker,
  };
};

// what a container logged, for a broker that did not come up
const logsOf = (broker) => {
  if (!broker.startsWith('bead-mqtt-')) {
    return '';
  }

  const logs = spawnSync('docker', ['logs', '--tail', '50', broker], { encoding: 'utf8' });
  return `${logs.stdout ?? ''}${logs.stderr ?? ''}`;
};

// the folder of a native broker by its process's id
const nativeFolderOf = (pid) => {
  const folders = join(tmpdir(), FOLDERS);

  if (!existsSync(folders)) {
    return null;
  }

  for (const name of readdirSync(folders)) {
    const file = join(folders, name, 'broker.pid');

    if (existsSync(file) && readFileSync(file, 'utf8').trim() === pid) {
      return join(folders, name);
    }
  }

  return null;
};

// a broker removed, and its folder: a container, or a native process
export const stop = (broker) => {
  if (broker.startsWith('bead-mqtt-')) {
    const inspected = spawnSync(
      'docker',
      ['inspect', '--format', '{{ index .Config.Labels "bead.mqtt.folder" }}', broker],
      {
        encoding: 'utf8',
      }
    );
    spawnSync('docker', ['rm', '--force', broker], { stdio: 'ignore' });
    const folder = inspected.status === 0 ? inspected.stdout.trim() : '';

    if (folder !== '') {
      rmSync(folder, { recursive: true, force: true });
    }

    return;
  }

  const folder = nativeFolderOf(broker);

  try {
    process.kill(Number(broker));
  } catch {
    // a process already ended has nothing left to end
  }

  if (folder !== null) {
    rmSync(folder, { recursive: true, force: true });
  }
};

// ── The command line ──────────────────────────────────────────────────────────

const USAGE = [
  'usage: node tools/mqtt-broker.mjs start [--native <folder>] [--github-env]',
  '       node tools/mqtt-broker.mjs stop [<broker>]',
  '       node tools/mqtt-broker.mjs run [--native <folder>] -- <command…>',
].join('\n');

// what the command line asks, or the reason it is no usage
export const parseCommand = (args) => {
  const [action, ...rest] = args;
  const separator = rest.indexOf('--');
  const own = separator === -1 ? rest : rest.slice(0, separator);
  const command = separator === -1 ? [] : rest.slice(separator + 1);
  const parsed = { action, githubEnv: false, native: undefined, broker: undefined, command };

  for (let at = 0; at < own.length; at += 1) {
    if (own[at] === '--native' && at + 1 < own.length && action !== 'stop') {
      parsed.native = own[at + 1];
      at += 1;
    } else if (own[at] === '--github-env' && action === 'start') {
      parsed.githubEnv = true;
    } else if (action === 'stop' && parsed.broker === undefined && BROKER.test(own[at])) {
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
const powerShellQuoted = (value) => {
  return `'${value.replaceAll("'", "''")}'`;
};

// a command's words as a shell reads them back, for a command a .cmd may run on Windows
const commandLineOf = (words) => {
  return words
    .map((word) => {
      return /^[\w./:=@\\-]+$/.test(word) ? word : `"${word.replaceAll('"', '\\"')}"`;
    })
    .join(' ');
};

const runCommand = async (parsed) => {
  const variables = await start({ native: parsed.native });
  process.stderr.write(`broker ${variables.BEAD_MQTT_BROKER} at ${variables.BEAD_MQTT_URL}\n`);

  let stopped = false;

  const stopOnce = () => {
    if (!stopped) {
      stopped = true;
      stop(variables.BEAD_MQTT_BROKER);
    }
  };

  // ! a broker left up keeps its participants' ids, which the next run's links would take over
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
      process.stderr.write(`${error.message}\n`);
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

const main = async () => {
  const parsed = parseCommand(process.argv.slice(2));

  if (parsed.problem !== undefined) {
    process.stderr.write(`${parsed.problem}\n${USAGE}\n`);
    return 2;
  }

  if (parsed.action === 'run') {
    return runCommand(parsed);
  }

  if (parsed.action === 'stop') {
    const broker = parsed.broker ?? process.env.BEAD_MQTT_BROKER;

    if (broker === undefined || !BROKER.test(broker)) {
      process.stderr.write(`no broker named, and BEAD_MQTT_BROKER names none\n${USAGE}\n`);
      return 2;
    }

    stop(broker);
    return 0;
  }

  if (parsed.githubEnv && process.env.GITHUB_ENV === undefined) {
    process.stderr.write(`--github-env, and GITHUB_ENV names no file\n${USAGE}\n`);
    return 2;
  }

  const variables = await start({ native: parsed.native });

  if (parsed.githubEnv) {
    // ! the mask before any line that could print the password
    process.stdout.write(`::add-mask::${variables.BEAD_MQTT_PASSWORD}\n`);
    appendFileSync(
      process.env.GITHUB_ENV,
      Object.entries(variables)
        .map(([name, value]) => {
          return `${name}=${value}\n`;
        })
        .join('')
    );
    process.stdout.write(`broker ${variables.BEAD_MQTT_BROKER} at ${variables.BEAD_MQTT_URL}\n`);
    return 0;
  }

  for (const [name, value] of Object.entries(variables)) {
    process.stdout.write(`$env:${name} = ${powerShellQuoted(value)}\n`);
  }

  return 0;
};

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
