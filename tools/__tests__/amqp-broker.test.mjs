import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  AMQP_HEADER,
  CLOSE_FRAME,
  DESCRIPTOR,
  HEARTBEAT,
  INTEROP,
  SASL_HEADER,
  UNPROVISIONED,
  brokerOf,
  closeConditionOf,
  configurationOf,
  definitionsOf,
  exactly,
  frameOf,
  grantsOf,
  nextOf,
  openFrame,
  outcomeCodeOf,
  parseCommand,
  passwordHashOf,
  provisionedOf,
  saslInitFrame,
  usersOf,
} from '../amqp-broker.mjs';

const DOCUMENT = JSON.parse(
  readFileSync(new URL('../../spec/transports.json', import.meta.url), 'utf8')
);

const BROKER = {
  exchange: 'bead',
  maximumMessageSize: 4096,
  names: ['interop'],
  users: ['peer', 'peer.1', 'server'],
};

// a user's grants, its regular expressions as RabbitMQ reads them
const grantOf = (user) => {
  const grant = grantsOf(BROKER).find((each) => {
    return each.user === user;
  });
  const of = (pattern) => {
    return pattern === '' ? /^$/ : new RegExp(pattern);
  };

  return {
    ...grant,
    may: {
      configure: of(grant.configure),
      write: of(grant.write),
      read: of(grant.read),
      topicWrite: grant.topic === undefined ? undefined : of(grant.topic.write),
      topicRead: grant.topic === undefined ? undefined : of(grant.topic.read),
    },
  };
};

describe('the broker the cases play against', () => {
  test('is read from spec/transports.json, its exchange, its names and its users', () => {
    const broker = brokerOf(DOCUMENT);

    assert.equal(broker.maximumMessageSize, 4096);
    assert.equal(broker.exchange, 'bead');
    assert.ok(broker.names.includes('interop'));
    assert.ok(['server', 'client', 'peer', 'peer.1'].every((user) => broker.users.includes(user)));
  });

  test('refuses a file that describes none', () => {
    assert.throws(() => {
      brokerOf({ brokers: { mqtt: {} } });
    }, /brokers\.amqp/);
  });

  test('authenticates every id the cases over AMQP 1.0 link as, and provisions every name they connect to but those no deployment provisioned', () => {
    const broker = brokerOf(DOCUMENT);
    const users = usersOf(broker);
    const queues = provisionedOf(broker);
    const ids = new Set();
    const connects = new Set();

    const walk = (value) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === 'object') {
        for (const [key, each] of Object.entries(value)) {
          if (key === 'id' && typeof each === 'string') {
            ids.add(each);
          } else if (key === 'connect' && typeof each === 'string') {
            connects.add(each);
          }

          walk(each);
        }
      }
    };

    for (const each of DOCUMENT.cases) {
      if (each.transport === 'amqp') {
        walk(each.steps);
      }
    }

    assert.ok(ids.size > 0 && connects.size > 0);

    for (const id of ids) {
      assert.ok(users.includes(id), id);
    }

    for (const name of connects) {
      assert.ok(
        queues.includes(`bead.s.${name}`) !== UNPROVISIONED.includes(name),
        `${name}: provisioned or left unprovisioned, never both`
      );
    }
  });

  test('authenticates the cases’ users, the interop’s and its own check’s, each once', () => {
    assert.deepEqual(usersOf({ ...BROKER, users: ['peer', 'ts-server'] }), [
      'peer',
      'ts-server',
      'cs-server',
      'ts-client',
      'cs-client',
      'fixture',
    ]);
  });

  test('bounds its messages, holds no user to the loopback, lowers its heartbeat and imports its definitions as it boots', () => {
    const lines = configurationOf(BROKER, { definitions: '/bead/definitions.json' }).split('\n');

    for (const line of [
      'listeners.tcp.default = 5672',
      'max_message_size = 4096',
      'loopback_users = none',
      `heartbeat = ${HEARTBEAT}`,
      'definitions.import_backend = local_filesystem',
      'definitions.local.path = /bead/definitions.json',
    ]) {
      assert.ok(lines.includes(line), line);
    }

    assert.equal(HEARTBEAT, 10);
  });
});

describe('spec 15.38’s permissions', () => {
  test('match each text given to the letter, anchored', () => {
    assert.equal(exactly(['bead.i.peer.1']), '^bead\\.i\\.peer\\.1$');
    assert.equal(exactly(['bead', 'bead.i.a']), '^(bead|bead\\.i\\.a)$');

    const pattern = new RegExp(exactly(['bead.i.peer']));
    assert.ok(pattern.test('bead.i.peer'));
    assert.ok(!pattern.test('bead.i.peer.1'));
    assert.ok(!pattern.test('beadxixpeer'));
  });

  test('let a participant alone configure, bind and read its inbox, and every participant write any inbox', () => {
    const peer = grantOf('peer');
    const other = grantOf('peer.1');

    assert.ok(peer.may.configure.test('bead.i.peer'));
    assert.ok(!peer.may.configure.test('bead.i.peer.1'));
    assert.ok(other.may.configure.test('bead.i.peer.1'));
    assert.ok(peer.may.write.test('bead') && peer.may.write.test('bead.i.peer'));
    assert.ok(!peer.may.write.test('bead.i.server'));
    assert.ok(peer.may.read.test('bead.i.peer') && !peer.may.read.test('bead.i.server'));
    assert.ok(peer.may.topicRead.test('bead.i.peer') && !peer.may.topicRead.test('bead.i.server'));

    for (const user of [...BROKER.users, ...Object.keys(INTEROP.servers), ...INTEROP.clients]) {
      const grant = grantOf(user);

      for (const inbox of ['bead.i.peer', 'bead.i.peer.1', 'bead.i.server', 'bead.i.ts-server']) {
        assert.ok(grant.may.topicWrite.test(inbox), `${user} writes ${inbox}`);
      }

      assert.ok(!grant.may.topicWrite.test('bead.i.fixture'), user);
      assert.ok(!grant.may.configure.test('bead.s.interop'), user);
      assert.ok(!grant.may.configure.test('bead'), user);
    }
  });

  test('let each case’s user serve and call every name of the cases, and read a queue of its own bound by them', () => {
    const peer = grantOf('peer');

    for (const name of ['bead.s.interop', 'bead.s.nobody']) {
      assert.ok(peer.may.read.test(name), name);
      assert.ok(peer.may.topicWrite.test(name), name);
      assert.ok(peer.may.topicRead.test(name), name);
    }

    assert.ok(peer.may.configure.test('bead.p.peer') && peer.may.write.test('bead.p.peer'));
    assert.ok(peer.may.read.test('bead.p.peer') && !peer.may.read.test('bead.p.server'));

    for (const name of INTEROP.names) {
      assert.ok(!peer.may.read.test(`bead.s.${name}`), name);
      assert.ok(!peer.may.topicWrite.test(`bead.s.${name}`), name);
    }
  });

  test('let the interop’s servers read their names alone and its clients write them, neither a queue of its own', () => {
    const server = grantOf('ts-server');
    const client = grantOf('cs-client');

    assert.deepEqual(
      INTEROP.names.filter((name) => {
        return server.may.read.test(`bead.s.${name}`);
      }),
      INTEROP.servers['ts-server']
    );
    assert.ok(!server.may.topicWrite.test('bead.s.interop-ts'));
    assert.ok(
      INTEROP.names.every((name) => {
        return (
          client.may.topicWrite.test(`bead.s.${name}`) && !client.may.read.test(`bead.s.${name}`)
        );
      })
    );
    assert.ok(!client.may.topicWrite.test('bead.s.interop'));
    assert.ok(!server.may.configure.test('bead.p.ts-server'));
  });

  test('let the readiness check’s user read every queue, its listing and its purge, and configure and write nothing', () => {
    const fixture = grantOf('fixture');

    assert.equal(fixture.configure, '');
    assert.equal(fixture.write, '');
    assert.equal(fixture.topic, undefined);
    assert.ok(fixture.may.read.test('bead.i.peer') && fixture.may.read.test('bead.s.interop'));
    assert.ok(!fixture.may.read.test('amq.default'));
  });
});

describe('the definitions it imports', () => {
  test('provision the root’s topic exchange and a queue for each name, bound to it by its own name, and none for a name no deployment provisioned', () => {
    const definitions = definitionsOf(BROKER, { password: 'p' });

    assert.deepEqual(definitions.exchanges, [
      {
        name: 'bead',
        vhost: '/',
        type: 'topic',
        durable: true,
        auto_delete: false,
        internal: false,
        arguments: {},
      },
    ]);
    assert.deepEqual(
      definitions.queues.map((queue) => {
        return queue.name;
      }),
      ['bead.s.interop', 'bead.s.interop-ts', 'bead.s.interop-cs', 'bead.s.interop-both']
    );
    assert.ok(
      definitions.queues.every((queue) => {
        return queue.durable && queue.arguments['x-queue-type'] === 'classic';
      })
    );
    assert.deepEqual(
      definitions.bindings.map((binding) => {
        return [binding.source, binding.destination, binding.destination_type, binding.routing_key];
      }),
      definitions.queues.map((queue) => {
        return ['bead', queue.name, 'queue', queue.name];
      })
    );
    assert.ok(
      !definitions.queues.some((queue) => {
        return queue.name === 'bead.s.nobody';
      })
    );
    assert.deepEqual(definitions.vhosts, [{ name: '/' }]);
  });

  test('authenticate each user by the run’s password, as RabbitMQ hashes it: a salt, then the SHA-256 of the salt and the password', () => {
    const salt = Buffer.from([1, 2, 3, 4]);
    const hash = Buffer.from(passwordHashOf('pässword', salt), 'base64');

    assert.equal(hash.length, 36);
    assert.deepEqual(hash.subarray(0, 4), salt);
    assert.deepEqual(
      hash.subarray(4),
      createHash('sha256')
        .update(Buffer.concat([salt, Buffer.from('pässword', 'utf8')]))
        .digest()
    );
    assert.notEqual(passwordHashOf('p'), passwordHashOf('p'));

    const definitions = definitionsOf(BROKER, {
      password: 'p',
      saltOf: () => {
        return salt;
      },
    });

    assert.deepEqual(
      definitions.users.map((user) => {
        return user.name;
      }),
      usersOf(BROKER)
    );
    assert.ok(
      definitions.users.every((user) => {
        return (
          user.password_hash === passwordHashOf('p', salt) &&
          user.hashing_algorithm === 'rabbit_password_hashing_sha256' &&
          user.tags.length === 0
        );
      })
    );
  });

  test('grant each user its permissions on the vhost, and its topic permissions on the root’s exchange', () => {
    const definitions = definitionsOf(BROKER, { password: 'p' });
    const grants = grantsOf(BROKER);

    assert.equal(definitions.permissions.length, usersOf(BROKER).length);
    assert.deepEqual(
      definitions.topic_permissions.map((each) => {
        return [each.user, each.exchange, each.vhost];
      }),
      grants
        .filter((grant) => {
          return grant.topic !== undefined;
        })
        .map((grant) => {
          return [grant.user, 'bead', '/'];
        })
    );
  });
});

describe('AMQP 1.0, by hand', () => {
  test('writes its protocol headers, SASL’s then AMQP’s', () => {
    assert.deepEqual([...SASL_HEADER], [0x41, 0x4d, 0x51, 0x50, 3, 1, 0, 0]);
    assert.deepEqual([...AMQP_HEADER], [0x41, 0x4d, 0x51, 0x50, 0, 1, 0, 0]);
  });

  test('writes a sasl-init of PLAIN, its user its authorization and authentication ids', () => {
    assert.deepEqual(
      [...saslInitFrame({ user: 'u', password: 'p' })],
      [
        0, 0, 0, 27, 2, 1, 0, 0, 0x00, 0x53, 0x41, 0xc0, 14, 2, 0xa3, 5, 0x50, 0x4c, 0x41, 0x49,
        0x4e, 0xa0, 4, 0, 0x75, 0, 0x70,
      ]
    );
  });

  test('writes an OPEN of its container-id alone, and a CLOSE of no error', () => {
    assert.deepEqual(
      [...openFrame('f')],
      [0, 0, 0, 17, 2, 0, 0, 0, 0x00, 0x53, 0x10, 0xc0, 4, 1, 0xa1, 1, 0x66]
    );
    assert.deepEqual([...CLOSE_FRAME], [0, 0, 0, 12, 2, 0, 0, 0, 0x00, 0x53, 0x18, 0x45]);
  });

  test('writes a list past 255 bytes as a list32', () => {
    const frame = openFrame('x'.repeat(300));

    assert.equal(frame.readUInt32BE(0), frame.length);
    assert.deepEqual([...frame.subarray(8, 12)], [0x00, 0x53, 0x10, 0xd0]);
    assert.equal(frame.readUInt32BE(12), 4 + 5 + 300);
    assert.equal(frame.readUInt32BE(16), 1);
    assert.deepEqual([...frame.subarray(20, 25)], [0xb1, 0, 0, 1, 44]);
  });

  test('reads a header or a frame once it is whole, and what follows it as the rest', () => {
    const outcome = frameOf(1, Buffer.from([0x00, 0x53, 0x44, 0xc0, 3, 1, 0x50, 0]));
    const received = Buffer.concat([SASL_HEADER, outcome, Buffer.from([0])]);

    assert.equal(nextOf(received.subarray(0, 7)), undefined);

    const header = nextOf(received);
    assert.equal(header.header, 3);

    assert.equal(nextOf(header.rest.subarray(0, outcome.length - 1)), undefined);

    const frame = nextOf(header.rest);
    assert.equal(frame.frame.type, 1);
    assert.equal(frame.frame.descriptor, DESCRIPTOR.outcome);
    assert.equal(outcomeCodeOf(frame.frame.body), 0);
    assert.deepEqual([...frame.rest], [0]);
    assert.equal(nextOf(frameOf(0, Buffer.alloc(0))).frame.descriptor, null);
    assert.match(nextOf(Buffer.from([0, 0, 0, 4, 2, 0, 0, 0])).problem, /4 bytes/);
  });

  test('reads a sasl-outcome’s code, and a CLOSE’s condition or no error', () => {
    assert.equal(outcomeCodeOf(Buffer.from([0x00, 0x53, 0x44, 0xc0, 3, 1, 0x50, 1])), 1);
    assert.equal(outcomeCodeOf(Buffer.from([0x00, 0x53, 0x44, 0x45])), null);
    assert.equal(closeConditionOf(Buffer.from([0x00, 0x53, 0x18, 0x45])), null);
    assert.equal(closeConditionOf(Buffer.from([0x00, 0x53, 0x18, 0xc0, 2, 1, 0x40])), null);

    const condition = Buffer.from('amqp:not-allowed', 'ascii');
    const error = Buffer.concat([
      Buffer.from([0x00, 0x53, 0x1d, 0xc0, condition.length + 3, 1, 0xa3, condition.length]),
      condition,
    ]);
    const close = Buffer.concat([
      Buffer.from([0x00, 0x53, 0x18, 0xc0, error.length + 1, 1]),
      error,
    ]);

    assert.equal(closeConditionOf(close), 'amqp:not-allowed');
  });
});

describe('the command line', () => {
  test('takes start, stop and run, and run its command after --', () => {
    assert.deepEqual(parseCommand(['start', '--github-env']), {
      action: 'start',
      githubEnv: true,
      broker: undefined,
      command: [],
    });
    assert.equal(parseCommand(['stop', 'bead-amqp-0a1b2c3d']).broker, 'bead-amqp-0a1b2c3d');
    assert.deepEqual(parseCommand(['run', '--', 'yarn', 'test:amqp']).command, [
      'yarn',
      'test:amqp',
    ]);
  });

  test('refuses what is no usage, naming it, a broker of MQTT’s and a native broker among it', () => {
    assert.match(parseCommand([]).problem, /no action/);
    assert.match(parseCommand(['run']).problem, /after --/);
    assert.match(parseCommand(['stop', 'bead-mqtt-0a1b2c3d']).problem, /bead-mqtt-0a1b2c3d/);
    assert.match(parseCommand(['start', '--native', 'C:/m']).problem, /--native/);
    assert.match(parseCommand(['start', '--', 'x']).problem, /takes no command/);
  });
});
