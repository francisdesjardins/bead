import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  DISCONNECT,
  INTEROP,
  aclOf,
  brokerOf,
  configurationOf,
  connackReasonOf,
  connectPacket,
  parseCommand,
  usersOf,
  variableByteInteger,
} from '../mqtt-broker.mjs';

const BROKER = {
  maximumPacketSize: 4096,
  retainAvailable: false,
  sharedSubscriptions: true,
  users: ['peer', 'server'],
};

describe('the broker the cases play against', () => {
  test('is read from spec/transports.json, its users each case names', () => {
    const broker = brokerOf(
      JSON.parse(readFileSync(new URL('../../spec/transports.json', import.meta.url), 'utf8'))
    );

    assert.equal(broker.maximumPacketSize, 4096);
    assert.ok(
      broker.users.includes('server') &&
        broker.users.includes('client') &&
        broker.users.includes('peer')
    );
  });

  test('refuses a file that describes none', () => {
    assert.throws(() => {
      brokerOf({ brokers: {} });
    }, /brokers\.mqtt/);
  });

  test('authenticates the cases’ users, the interop’s and its own check’s, each once', () => {
    const users = usersOf({ ...BROKER, users: ['peer', 'ts-server'] });

    assert.deepEqual(users, [
      'peer',
      'ts-server',
      'cs-server',
      'ts-client',
      'cs-client',
      'fixture',
    ]);
  });

  test('bounds its packets, refuses retained messages, lifts its queues and ties a Client Identifier to its user', () => {
    const text = configurationOf(BROKER, {
      folder: '/c',
      mqttPort: 1883,
      webSocketPort: 9001,
      bind: '0.0.0.0',
    });

    for (const line of [
      'allow_anonymous false',
      'persistence false',
      'max_packet_size 4096',
      'retain_available false',
      'max_queued_messages 0',
      'max_inflight_messages 0',
      'listener 1883 0.0.0.0',
      'listener 9001 0.0.0.0',
      'protocol websockets',
    ]) {
      assert.ok(text.split('\n').includes(line), line);
    }

    assert.equal(
      text.split('\n').filter((line) => line === 'use_username_as_clientid true').length,
      2
    );
  });

  test('grants spec 15.31’s access: each name on its own topic, the interop’s servers their names alone', () => {
    const lines = aclOf(BROKER).split('\n');

    assert.deepEqual(lines.slice(0, 4), [
      'pattern read bead/i/%u',
      'pattern write bead/d/%u',
      'pattern write bead/i/+',
      'pattern read bead/d/+',
    ]);
    assert.ok(!lines.some((line) => line.includes('$share')));

    const tsServer = lines.slice(
      lines.indexOf('user ts-server') + 1,
      lines.indexOf('user cs-server') - 1
    );
    assert.deepEqual(
      tsServer,
      INTEROP.servers['ts-server'].map((name) => `topic read bead/s/${name}`)
    );
  });
});

describe('MQTT 5, by hand', () => {
  test('writes a Variable Byte Integer at each width', () => {
    assert.deepEqual([...variableByteInteger(127)], [0x7f]);
    assert.deepEqual([...variableByteInteger(128)], [0x80, 0x01]);
    assert.deepEqual([...variableByteInteger(16_384)], [0x80, 0x80, 0x01]);
    assert.deepEqual([...variableByteInteger(268_435_455)], [0xff, 0xff, 0xff, 0x7f]);
  });

  test('writes a CONNECT of version 5 and Clean Start 1, its user its Client Identifier and its User Name', () => {
    const packet = connectPacket({ user: 'u', password: 'p', keepAlive: 10 });

    assert.deepEqual(
      [...packet],
      [
        0x10, 20, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 0xc2, 0, 10, 0, 0, 1, 0x75, 0, 1, 0x75, 0, 1,
        0x70,
      ]
    );
    assert.deepEqual([...DISCONNECT], [0xe0, 0x00]);
  });

  test('reads a CONNACK’s Reason Code once it is whole, and no CONNACK as none', () => {
    assert.equal(connackReasonOf(Buffer.from([0x20])), undefined);
    assert.equal(connackReasonOf(Buffer.from([0x20, 3, 0, 0])), undefined);
    assert.equal(connackReasonOf(Buffer.from([0x20, 3, 0, 0, 0])), 0);
    assert.equal(connackReasonOf(Buffer.from([0x20, 3, 0, 0x87, 0])), 0x87);
    assert.equal(connackReasonOf(Buffer.from([0x30, 0])), null);
  });
});

describe('the command line', () => {
  test('takes start, stop and run, and run its command after --', () => {
    assert.deepEqual(parseCommand(['start', '--github-env']), {
      action: 'start',
      githubEnv: true,
      native: undefined,
      broker: undefined,
      command: [],
    });
    assert.equal(parseCommand(['stop', 'bead-mqtt-0a1b2c3d']).broker, 'bead-mqtt-0a1b2c3d');
    assert.deepEqual(parseCommand(['run', '--native', 'C:/m', '--', 'yarn', 'test:mqtt']).command, [
      'yarn',
      'test:mqtt',
    ]);
    assert.equal(parseCommand(['run', '--native', 'C:/m', '--', 'yarn']).native, 'C:/m');
  });

  test('refuses what is no usage, naming it', () => {
    assert.match(parseCommand([]).problem, /no action/);
    assert.match(parseCommand(['run']).problem, /after --/);
    assert.match(parseCommand(['stop', 'somebody']).problem, /somebody/);
    assert.match(parseCommand(['start', '--', 'x']).problem, /takes no command/);
    assert.match(parseCommand(['stop', '--github-env']).problem, /--github-env/);
  });
});
