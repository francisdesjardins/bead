#!/usr/bin/env node
// A RabbitMQ 4.4.0 of the run's own, which every AMQP 1.0 case, adapter suite and interop leg plays
// against (spec 15.32 to 15.38, decision 0043): the broker `spec/transports.json`'s `brokers.amqp`
// describes, its root's topic exchange and its names' queues provisioned, its permissions 15.38's for
// the cases' users and the interop's, a password drawn for the run, under a container name and a
// loopback port of its own, so that two runs on one machine share no broker. Docker runs the image by
// its digest.
//
//   node tools/amqp-broker.mjs start [--github-env]
//   node tools/amqp-broker.mjs stop [<broker>]
//   node tools/amqp-broker.mjs run -- <command…>
//
// start prints BEAD_AMQP_URL, BEAD_AMQP_PASSWORD and BEAD_AMQP_BROKER as PowerShell's `$env:` lines,
// or, with --github-env, appends them to $GITHUB_ENV, the password masked first. stop removes that
// broker and its folder, BEAD_AMQP_BROKER's by default. run starts a broker, runs the command with
// those variables set, and stops the broker whatever the command's end, its exit code the command's.
// Its files go to the run's temporary folder (TMP). Exit 1 on a broker that does not come up, 2 on a
// usage error. What is no broker's own is `tools/broker-fixture.mjs`'s.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import {
  INTEROP,
  READINESS_USER,
  containerNameOf,
  drawPassword,
  folderFor,
  isContainerOf,
  logsOf,
  parseCommand as parseFixtureCommand,
  pause,
  pullImage,
  removeContainer,
  runContainer,
  runFixture,
  transportsDocument,
} from './broker-fixture.mjs';

export { INTEROP };

// ! the image by its digest alone: a tag names whatever was pushed under it last
export const IMAGE =
  'rabbitmq:4.4.0-management@sha256:c200fd496482cda18c412be4e6f244830e1e75949b8cf5f0e887cea9ea456109';

// the port RabbitMQ listens on inside its container, AMQP over TCP
const AMQP_PORT = 5672;

// ! three heartbeats of silence and the broker's close, about 40 s at 10, are how long an id's next
// link waits after its former one went silent (spec 15.38), which a twin waits out
export const HEARTBEAT = 10;

// how long a broker has to answer an authenticated OPEN once its container runs: RabbitMQ boots in
// seconds, and a runner that just pulled it takes longer
const READY_WITHIN = 90_000;

// a broker's name, as start draws it: a container's
const BROKER = /^bead-amqp-[0-9a-f]{8}$/;

// the kind of broker, which names its containers, its folders and its variables
const KIND = 'amqp';

// the names the cases' users serve and call that no deployment provisioned, so that an OPEN to one
// is released as no subscriber and a receiver of one is detached as not found (spec 15.34, 15.35)
export const UNPROVISIONED = Object.freeze(['nobody']);

// ── The broker's files ────────────────────────────────────────────────────────

// the broker the cases play against, as spec/transports.json describes it
export const brokerOf = (document) => {
  const broker = document?.brokers?.amqp;

  if (
    broker === undefined ||
    !Array.isArray(broker.users) ||
    !Array.isArray(broker.names) ||
    typeof broker.exchange !== 'string' ||
    !Number.isInteger(broker.maximumMessageSize)
  ) {
    throw new Error(
      'spec/transports.json describes no brokers.amqp, its users, its names, its exchange and its maximumMessageSize'
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

// a topic's queue, its tokens joined by `.` (spec 15.32): an inbox, a name's queue, and the queue a
// case's peer in the client role reads a name through, exclusive to its link
export const inboxOf = (broker, id) => {
  return `${broker.exchange}.i.${id}`;
};

export const nameQueueOf = (broker, name) => {
  return `${broker.exchange}.s.${name}`;
};

export const peerQueueOf = (broker, id) => {
  return `${broker.exchange}.p.${id}`;
};

// the queues the deployment provisions, each bound to its root's exchange by its own name: the
// cases' names and the interop's (spec 15.38)
export const provisionedOf = (broker) => {
  return [...new Set([...broker.names, ...INTEROP.names])].map((name) => {
    return nameQueueOf(broker, name);
  });
};

// a text as a regular expression reads it to the letter
const literal = (text) => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// one anchored regular expression that matches each text given and nothing else
export const exactly = (texts) => {
  const each = texts.map(literal);
  return `^${each.length === 1 ? each[0] : `(${each.join('|')})`}$`;
};

// one pattern that matches each list's texts, each list anchored on its own, an empty one left out
const eitherOf = (lists) => {
  return lists
    .filter((texts) => {
      return texts.length > 0;
    })
    .map(exactly)
    .join('|');
};

// what each user may do, by spec 15.38's permissions: a participant alone configures, binds and
// reads its own inbox; every participant writes the root's exchange and, by its topic permissions,
// the inbox of every user; a server's participants alone read its name's queue, and its clients
// alone write its name. Each case's user serves and calls every name of the cases, so that a peer
// plays an acceptor, and in the client role declares, binds by those names and reads a queue of its
// own; the interop's servers read their names alone, its clients write them; and the readiness
// check's user reads what a queue holds, its listing and its purge, and configures and writes
// nothing
export const grantsOf = (broker) => {
  const root = broker.exchange;
  const cases = [...broker.names, ...UNPROVISIONED];
  const participants = usersOf(broker).filter((user) => {
    return user !== READINESS_USER;
  });
  const inboxes = participants.map((user) => {
    return inboxOf(broker, user);
  });
  const queuesOf = (names) => {
    return names.map((name) => {
      return nameQueueOf(broker, name);
    });
  };

  const grants = participants.map((user) => {
    const isCase = broker.users.includes(user);
    const serves = [...(isCase ? cases : []), ...(INTEROP.servers[user] ?? [])];
    const calls = [
      ...(isCase ? cases : []),
      ...(INTEROP.clients.includes(user) ? INTEROP.names : []),
    ];
    const own = [inboxOf(broker, user), ...(isCase ? [peerQueueOf(broker, user)] : [])];
    const bindsBy = isCase ? cases : [];

    return {
      user,
      configure: exactly(own),
      write: exactly([root, ...own]),
      read: exactly([root, ...own, ...queuesOf(serves)]),
      topic: {
        write: eitherOf([inboxes, queuesOf(calls)]),
        read: eitherOf([[inboxOf(broker, user)], queuesOf(bindsBy)]),
      },
    };
  });

  return [
    ...grants,
    {
      user: READINESS_USER,
      configure: '',
      write: '',
      read: `^${literal(root)}\\..+$`,
      topic: undefined,
    },
  ];
};

// a password as RabbitMQ keeps it: four bytes of salt, then the SHA-256 of the salt and the
// password's UTF-8, in base64 (`rabbit_password_hashing_sha256`)
export const passwordHashOf = (password, salt = randomBytes(4)) => {
  const digest = createHash('sha256')
    .update(Buffer.concat([salt, Buffer.from(password, 'utf8')]))
    .digest();
  return Buffer.concat([salt, digest]).toString('base64');
};

// the definitions RabbitMQ imports as it boots: its users, each under the run's password, the
// vhost, its permissions, the root's topic exchange, and its names' queues and their bindings
export const definitionsOf = (broker, { password, saltOf = () => randomBytes(4) }) => {
  const vhost = '/';
  const grants = grantsOf(broker);
  const queues = provisionedOf(broker);

  return {
    users: usersOf(broker).map((name) => {
      return {
        name,
        password_hash: passwordHashOf(password, saltOf(name)),
        hashing_algorithm: 'rabbit_password_hashing_sha256',
        tags: [],
      };
    }),
    vhosts: [{ name: vhost }],
    permissions: grants.map(({ user, configure, write, read }) => {
      return { user, vhost, configure, write, read };
    }),
    topic_permissions: grants
      .filter(({ topic }) => {
        return topic !== undefined;
      })
      .map(({ user, topic }) => {
        return { user, vhost, exchange: broker.exchange, write: topic.write, read: topic.read };
      }),
    exchanges: [
      {
        name: broker.exchange,
        vhost,
        type: 'topic',
        durable: true,
        auto_delete: false,
        internal: false,
        arguments: {},
      },
    ],
    // classic and durable: a transient queue that is not exclusive is a deprecated feature of
    // RabbitMQ 4, and what the container holds is on a tmpfs, gone with it
    queues: queues.map((name) => {
      return {
        name,
        vhost,
        durable: true,
        auto_delete: false,
        arguments: { 'x-queue-type': 'classic' },
      };
    }),
    bindings: queues.map((name) => {
      return {
        source: broker.exchange,
        vhost,
        destination: name,
        destination_type: 'queue',
        routing_key: name,
        arguments: {},
      };
    }),
  };
};

// rabbitmq.conf: its listener, its max_message_size, which every sender's ATTACH names, no user held
// to the loopback inside its container, its heartbeat, and its definitions imported as it boots
export const configurationOf = (broker, { definitions }) => {
  return [
    `listeners.tcp.default = ${AMQP_PORT}`,
    `max_message_size = ${broker.maximumMessageSize}`,
    'loopback_users = none',
    `heartbeat = ${HEARTBEAT}`,
    'definitions.import_backend = local_filesystem',
    `definitions.local.path = ${definitions}`,
    'log.console = true',
    'log.console.level = info',
    '',
  ].join('\n');
};

// ── AMQP 1.0, by hand ─────────────────────────────────────────────────────────

// the protocol headers: SASL's, then AMQP's (AMQP 1.0 §2.2, §5.3.1)
export const SASL_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 3, 1, 0, 0]);
export const AMQP_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 1, 0, 0]);

// the descriptors of the performatives a check reads or writes (AMQP 1.0 §2.7, §5.3.3)
export const DESCRIPTOR = Object.freeze({
  open: 0x10,
  close: 0x18,
  error: 0x1d,
  mechanisms: 0x40,
  init: 0x41,
  outcome: 0x44,
});

// a value of a variable width, its one-byte code where it fits, its four-byte one otherwise
// (AMQP 1.0 §1.6)
const variable = (small, large, bytes) => {
  if (bytes.length <= 0xff) {
    return Buffer.concat([Buffer.from([small, bytes.length]), bytes]);
  }

  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([Buffer.from([large]), length, bytes]);
};

const symbolOf = (text) => {
  return variable(0xa3, 0xb3, Buffer.from(text, 'ascii'));
};

const stringOf = (text) => {
  return variable(0xa1, 0xb1, Buffer.from(text, 'utf8'));
};

const binaryOf = (bytes) => {
  return variable(0xa0, 0xb0, bytes);
};

// a performative: its descriptor, then its fields as a list8 or, past it, a list32 (AMQP 1.0 §1.6.22)
const performativeOf = (descriptor, fields) => {
  const content = Buffer.concat(fields);

  if (fields.length === 0) {
    return Buffer.from([0x00, 0x53, descriptor, 0x45]);
  }

  if (content.length + 1 <= 0xff) {
    return Buffer.concat([
      Buffer.from([0x00, 0x53, descriptor, 0xc0, content.length + 1, fields.length]),
      content,
    ]);
  }

  const head = Buffer.alloc(9);
  head.writeUInt8(0xd0, 0);
  head.writeUInt32BE(content.length + 4, 1);
  head.writeUInt32BE(fields.length, 5);
  return Buffer.concat([Buffer.from([0x00, 0x53, descriptor]), head, content]);
};

// a frame on channel 0: its size, its data offset of 2 words, its type, 0 for AMQP and 1 for SASL
// (AMQP 1.0 §2.3.1, §5.3.1)
export const frameOf = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.writeUInt8(2, 4);
  head.writeUInt8(type, 5);
  head.writeUInt16BE(0, 6);
  return Buffer.concat([head, body]);
};

// a sasl-init of PLAIN, its response the user, as its authorization and authentication ids, and its
// password (RFC 4616, AMQP 1.0 §5.3.3.2)
export const saslInitFrame = ({ user, password }) => {
  const response = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(user, 'utf8'),
    Buffer.from([0]),
    Buffer.from(password, 'utf8'),
  ]);
  return frameOf(1, performativeOf(DESCRIPTOR.init, [symbolOf('PLAIN'), binaryOf(response)]));
};

// an OPEN of its container-id alone (AMQP 1.0 §2.7.1)
export const openFrame = (containerId) => {
  return frameOf(0, performativeOf(DESCRIPTOR.open, [stringOf(containerId)]));
};

// a CLOSE of no error (AMQP 1.0 §2.7.9)
export const CLOSE_FRAME = frameOf(0, performativeOf(DESCRIPTOR.close, []));

// the fields of a list at a performative's head, from its code on: where they begin and how many
const listAt = (bytes, at) => {
  const code = bytes[at];

  if (code === 0x45) {
    return { count: 0, from: at + 1 };
  }

  if (code === 0xc0) {
    return { count: bytes[at + 2], from: at + 3 };
  }

  if (code === 0xd0) {
    return { count: bytes.readUInt32BE(at + 5), from: at + 9 };
  }

  return null;
};

// what a frame's body opens with: its performative's descriptor, and its list's first field
const describedOf = (body) => {
  if (body.length < 4 || body[0] !== 0x00 || body[1] !== 0x53) {
    return null;
  }

  return { descriptor: body[2], list: listAt(body, 3) };
};

// the next header or frame at the head of what a broker sent: undefined while it is not whole
export const nextOf = (received) => {
  if (received.length >= 4 && received.subarray(0, 4).toString('latin1') === 'AMQP') {
    if (received.length < 8) {
      return undefined;
    }

    return { header: received[4], rest: received.subarray(8) };
  }

  if (received.length < 8) {
    return undefined;
  }

  const size = received.readUInt32BE(0);

  if (size < 8) {
    return { problem: `a frame of ${size} bytes`, rest: Buffer.alloc(0) };
  }

  if (received.length < size) {
    return undefined;
  }

  const body = received.subarray(received[4] * 4, size);
  const described = describedOf(body);
  return {
    frame: { type: received[5], descriptor: described?.descriptor ?? null, body },
    rest: received.subarray(size),
  };
};

// a sasl-outcome's code, 0 for ok (AMQP 1.0 §5.3.3.6)
export const outcomeCodeOf = (body) => {
  const described = describedOf(body);
  const list = described?.list;

  if (list === null || list === undefined || list.count === 0 || body[list.from] !== 0x50) {
    return null;
  }

  return body[list.from + 1];
};

// the condition a CLOSE carries, or null where it carries no error (AMQP 1.0 §2.7.9, §2.8.14)
export const closeConditionOf = (body) => {
  const list = describedOf(body)?.list;

  if (list === null || list === undefined || list.count === 0 || body[list.from] === 0x40) {
    return null;
  }

  const error = describedOf(body.subarray(list.from));
  const fields = error?.list;
  const at = list.from + (fields?.from ?? 0);

  if (error?.descriptor !== DESCRIPTOR.error || fields === null || body[at] !== 0xa3) {
    return 'an error';
  }

  return body.subarray(at + 2, at + 2 + body[at + 1]).toString('ascii');
};

// one authenticated OPEN to the broker on that port, settled with null once its OPEN came and its
// CLOSE carried no error, or with what went wrong: SASL PLAIN as the readiness check's user, an OPEN
// answered, then a CLOSE of no error answered
export const openOf = (port, password) => {
  return new Promise((settle) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let received = Buffer.alloc(0);
    let opened = false;
    let settled = false;

    const end = (problem) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      settle(problem);
    };

    const read = (item) => {
      if (item.problem !== undefined) {
        end(item.problem);
        return;
      }

      if (item.header !== undefined) {
        return;
      }

      const { type, descriptor, body } = item.frame;

      if (type === 1 && descriptor === DESCRIPTOR.mechanisms) {
        socket.write(saslInitFrame({ user: READINESS_USER, password }));
      } else if (type === 1 && descriptor === DESCRIPTOR.outcome) {
        const code = outcomeCodeOf(body);

        if (code === 0) {
          socket.write(Buffer.concat([AMQP_HEADER, openFrame(READINESS_USER)]));
        } else {
          end(`the broker answered its SASL PLAIN with the code ${code}`);
        }
      } else if (type === 0 && descriptor === DESCRIPTOR.open) {
        opened = true;
        socket.write(CLOSE_FRAME);
      } else if (type === 0 && descriptor === DESCRIPTOR.close) {
        const condition = closeConditionOf(body);

        if (condition !== null) {
          end(`the broker closed its connection with ${condition}`);
        } else {
          end(opened ? null : 'the broker closed its connection before its OPEN');
        }
      }
    };

    socket.setTimeout(5_000, () => {
      end('no answer');
    });
    socket.on('connect', () => {
      socket.write(SASL_HEADER);
    });
    socket.on('data', (data) => {
      received = Buffer.concat([received, data]);

      for (let item = nextOf(received); item !== undefined && !settled; item = nextOf(received)) {
        received = item.rest;
        read(item);
      }
    });
    socket.on('error', () => {
      end('no answer');
    });
    socket.on('close', () => {
      end('no answer');
    });
  });
};

// ── Docker ────────────────────────────────────────────────────────────────────

// where the container reads its files: the run's folder, mounted read-only
const MOUNTED = '/bead';

// whether the broker's container still runs: one whose broker could not start ends at once
const isUp = (name) => {
  const inspected = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', name], {
    encoding: 'utf8',
  });
  return inspected.status === 0 && inspected.stdout.trim() === 'true';
};

// whether the broker's node runs, asked as its own user
// ! as root, the CLI reads root's Erlang cookie, not the node's, and never reaches it
const isRunning = (name) => {
  return (
    spawnSync(
      'docker',
      ['exec', '--user', 'rabbitmq', name, 'rabbitmq-diagnostics', '-q', 'check_running'],
      { stdio: 'ignore' }
    ).status === 0
  );
};

// ! a running node and an open port prove nothing of its definitions: the broker is up once it runs
// and its readiness user's OPEN is answered
const awaitReady = async ({ broker, port, password }) => {
  const deadline = Date.now() + READY_WITHIN;
  let problem = 'its node never ran';

  while (Date.now() < deadline) {
    if (!isUp(broker)) {
      throw new Error(`the broker's container ${broker} ended as it started`);
    }

    if (isRunning(broker)) {
      problem = await openOf(port, password);

      if (problem === null) {
        return;
      }
    }

    await pause(500);
  }

  throw new Error(
    `no broker answered an OPEN on 127.0.0.1:${port} within ${READY_WITHIN / 1000} s: ${problem}`
  );
};

const startInDocker = (broker, { folder, password }) => {
  const name = containerNameOf(KIND);
  const configuration = join(folder, 'rabbitmq.conf');

  writeFileSync(
    configuration,
    configurationOf(broker, { definitions: `${MOUNTED}/definitions.json` })
  );
  writeFileSync(
    join(folder, 'definitions.json'),
    `${JSON.stringify(definitionsOf(broker, { password }), null, 2)}\n`
  );

  pullImage(IMAGE);

  const ports = runContainer(KIND, {
    name,
    folder,
    image: IMAGE,
    ports: [AMQP_PORT],
    args: [
      // what the broker writes stays in the container's memory, owned by its user
      '--tmpfs',
      '/var/lib/rabbitmq:rw,uid=999,gid=999,mode=0700',
      '--mount',
      `type=bind,source=${folder},target=${MOUNTED},readonly`,
      '--mount',
      `type=bind,source=${configuration},target=/etc/rabbitmq/rabbitmq.conf,readonly`,
    ],
  });

  return { broker: name, port: ports[AMQP_PORT] };
};

// ── Start and stop ────────────────────────────────────────────────────────────

// a broker of the run's own, up: its variables, the URL its participants link to
export const start = async () => {
  const broker = brokerOf(transportsDocument());
  const password = drawPassword();
  const folder = folderFor(KIND);
  let started;

  try {
    started = startInDocker(broker, { folder, password });
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
    BEAD_AMQP_URL: `amqp://127.0.0.1:${started.port}`,
    BEAD_AMQP_PASSWORD: password,
    BEAD_AMQP_BROKER: started.broker,
  };
};

// a broker removed, and its folder
export const stop = (broker) => {
  if (isContainerOf(KIND, broker)) {
    removeContainer(KIND, broker);
  }
};

// ── The command line ──────────────────────────────────────────────────────────

const USAGE = [
  'usage: node tools/amqp-broker.mjs start [--github-env]',
  '       node tools/amqp-broker.mjs stop [<broker>]',
  '       node tools/amqp-broker.mjs run -- <command…>',
];

// what the command line asks, or the reason it is no usage
export const parseCommand = (args) => {
  return parseFixtureCommand(args, { brokers: BROKER });
};

if (import.meta.main) {
  runFixture({ broker: KIND, usage: USAGE, brokers: BROKER, start, stop });
}
