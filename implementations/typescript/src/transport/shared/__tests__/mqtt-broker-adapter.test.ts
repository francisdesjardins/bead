// ── MQTT broker adapter ───────────────────────────────────────────────────────

// The adapter over MQTT.js against a scripted MQTT 5 peer, which writes each answer itself and reads
// every packet as it goes; and a link over the WebSocket of the Mosquitto `BEAD_MQTT_URL` names.
// The C# side's `MqttBrokerAdapterTests` play the same sentences.

// dependencies

import { type AddressInfo, createServer } from 'node:net';
import { mock } from 'node:test';
import { MqttClient } from 'mqtt';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { generate, type IPublishPacket, type ISubscribePacket, type Packet } from 'mqtt-packet';
import { ParcelKind, readParcel, writeParcel } from '../broker-parcel';
import { createBrokerParticipant } from '../broker-participant';
import { BROKER_DELIVERIES, BROKER_PUBLISHED } from '../constants';
import { CancelError, GenericError, ProgrammerError } from '../errors';
import {
  createMqttBrokerAdapter,
  type IMqttBrokerAdapter,
  type IMqttBrokerAdapterOptions,
  MAXIMUM_PACKET_SIZE,
  TRANSPORT_MQTT,
} from '../mqtt-broker-adapter';
import { LARGEST_PACKET_SIZE, largestPayload } from '../mqtt-packets';
import type { IBrokerDown, IBrokerMessage, IBrokerStart } from '../types';
import { createLinkRelay } from '../../server/__tests__/link-relay';
import { TLS_FIXTURE } from '../../server/__tests__/tls-fixture';
import { createFrameRelay, unwholeOf } from './frame-relay';
import { createMqttScript, type IMqttScript, type IScriptedLink } from './mqtt-script';

// constants

const ID = 'ada';
const INBOX = Object.freeze(['bead', 'i', ID]);
const NAME = Object.freeze(['bead', 's', 'interop']);
const PASSWORD = 'secret';
// how long a case waits on what its adapter does, as the script waits on a packet
const PATIENCE = 5_000;

// the Mosquitto the broker's legs play against, where one is given, and the user the WebSocket leg
// links as, which no case and no interop leg is
const MQTT_URL = process.env['BEAD_MQTT_URL'];
const MQTT_WS_URL = process.env['BEAD_MQTT_WS_URL'];
const MQTT_PASSWORD = process.env['BEAD_MQTT_PASSWORD'] ?? '';
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)';
const FIXTURE_USER = 'fixture';
// ! users of the broker's that read every name, each linked by one case alone: a link of an id a
// case links meanwhile would take it over
const GROUP_USERS = Object.freeze(['quiet', 'late', 'flagged']);
// a CONNACK of 0x00, and the fixed header of a PUBLISH announcing 16,777,216 bytes after it
const CONNACK_BYTES = Object.freeze([0x20, 0x03, 0x00, 0x00, 0x00]);
const PAST_BYTES = Object.freeze([0x32, 0x80, 0x80, 0x80, 0x08]);

// helpers

/** An adapter of `ID` to `script`, its password `PASSWORD` unless a provider or a certificate is told. */
const adapterOf = (
  script: IMqttScript,
  options?: Partial<IMqttBrokerAdapterOptions>
): IMqttBrokerAdapter => {
  const password =
    options?.passwordProvider === undefined && options?.tls === undefined ? PASSWORD : undefined;

  return createMqttBrokerAdapter({ id: ID, password, url: script.url, ...options });
};

/** What `build` throws, or nothing. */
const refusalOf = (build: () => unknown): unknown => {
  try {
    build();
  } catch (error) {
    return error;
  }

  return undefined;
};

/** What `pending` fails with, or nothing. */
const failureOf = (pending: Promise<unknown>): Promise<unknown> => {
  return pending.then(
    () => {
      return undefined;
    },
    (error: unknown) => {
      return error;
    }
  );
};

/** `adapter` started, its link the script's next, answered by a CONNACK of `properties`. */
const linkUp = async (
  { adapter, script }: { adapter: IMqttBrokerAdapter; script: IMqttScript },
  options?: {
    properties?: Record<string, unknown> | undefined;
    will?: IBrokerStart['will'];
  }
): Promise<IScriptedLink & { connect: Packet }> => {
  const starting = adapter.start({ will: options?.will });
  const link = await script.link();

  link.send({
    cmd: 'connack',
    properties: options?.properties ?? {},
    reasonCode: 0,
    sessionPresent: false,
  });
  await starting;

  return link;
};

/** A SUBACK of `code` to the next SUBSCRIBE `link` reads, which it gives back. */
const subackOf = async (link: IScriptedLink, code: number): Promise<ISubscribePacket> => {
  const subscribe = (await link.next('subscribe')) as ISubscribePacket;

  link.send({
    cmd: 'suback',
    granted: [code],
    messageId: subscribe.messageId ?? 0,
    properties: {},
  });

  return subscribe;
};

/**
 * `stopping` settled, each UNSUBSCRIBE `link` reads meanwhile answered by an UNSUBACK of 0x00; the
 * filters they named, in their order.
 */
const unsubackedOf = async (link: IScriptedLink, stopping: Promise<unknown>): Promise<string[]> => {
  const filters: string[] = [];
  const stop = { isSettled: false };

  void stopping.finally(() => {
    stop.isSettled = true;
  });

  while (!stop.isSettled) {
    const unsubscribe = await link.next('unsubscribe', { within: 20 }).catch(() => {
      return undefined;
    });

    if (unsubscribe !== undefined) {
      filters.push(...(unsubscribe as { unsubscriptions: string[] }).unsubscriptions);
      link.send({
        cmd: 'unsuback',
        granted: [0],
        messageId: unsubscribe.messageId ?? 0,
        properties: {},
      });
    }
  }

  await stopping;

  return filters;
};

/** The messages and the downs `adapter` tells, as they come. */
const heardOf = (adapter: IMqttBrokerAdapter) => {
  const messages: IBrokerMessage[] = [];
  const downs: IBrokerDown[] = [];

  adapter.on('message', (message) => {
    messages.push(message);
  });
  adapter.on('down', (down) => {
    downs.push(down);
  });

  return { downs, messages };
};

/** Whether `link`'s adapter end closed within {@link PATIENCE}, its timer cleared either way. */
const closedWithin = async (link: IScriptedLink): Promise<boolean> => {
  const patience = new AbortController();

  try {
    return await Promise.race([
      link.closed.then(() => {
        return true;
      }),
      sleep(PATIENCE, false, { signal: patience.signal }),
    ]);
  } finally {
    // ! a timer left running outlives its case, and a later case of the worker counts it
    patience.abort();
  }
};

/** Polls `isDone` on the real clock until it holds, within five seconds. */
const until = async (isDone: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (!isDone() && Date.now() < deadline) {
    await sleep(5);
  }
};

/** `run`, each MQTT.js client that connects meanwhile kept in its order, its hook restored after. */
const withClients = async (run: (clients: MqttClient[]) => Promise<void>): Promise<void> => {
  const connect = MqttClient.prototype.connect;
  const clients: MqttClient[] = [];
  const hooked = mock.method(MqttClient.prototype, 'connect', function (this: MqttClient) {
    clients.push(this);

    return connect.call(this);
  });

  try {
    await run(clients);
  } finally {
    hooked.mock.restore();
  }
};

/**
 * `client`'s receiving seam, the first `bytes.length` bytes it receives pushed as one read, which
 * must be `bytes`, whatever chunks TCP hands it; what comes after passes as it comes. The reads it
 * pushed so.
 */
const oneReadOf = (client: MqttClient, bytes: readonly number[]): { reads: number } => {
  const { stream } = client;
  const push = stream.push.bind(stream);
  const pushed = { reads: 0 };
  let received = Buffer.alloc(0);

  stream.push = (chunk: Buffer | null): boolean => {
    if (chunk === null || pushed.reads > 0) {
      return push(chunk);
    }

    received = Buffer.concat([received, chunk]);

    if (received.length < bytes.length) {
      return true;
    }

    expect(received).toEqual(Buffer.from(bytes));
    pushed.reads += 1;

    return push(received);
  };

  return pushed;
};

/** The kinds of the packets that came on `link`, in their order. */
const cmdsOf = (link: IScriptedLink): Packet['cmd'][] => {
  return link.packets.map(({ cmd }) => {
    return cmd;
  });
};

const publishOf = (
  packet: Partial<Omit<IPublishPacket, 'payload'>> & { payload: Uint8Array; topic: string }
): IPublishPacket => {
  return {
    cmd: 'publish',
    dup: false,
    qos: 1,
    retain: false,
    ...packet,
    payload: Buffer.from(packet.payload),
  };
};

// definition

test.describe('createMqttBrokerAdapter', () => {
  test.describe.configure({ timeout: 20_000 });

  let script: IMqttScript;

  test.beforeEach(async () => {
    script = await createMqttScript();
  });

  test.afterEach(async () => {
    await script[Symbol.asyncDispose]();
  });

  test('connects a link that keeps no session, its id its Client Identifier, its password under its id or none under a certificate, Topic Alias Maximum 0, its Maximum Packet Size and its Keep Alive (spec 15.26)', async () => {
    let asked = 0;
    const adapter = adapterOf(script, {
      keepAlive: 1_500,
      maximumPacketSize: 2_048,
      passwordProvider: () => {
        asked += 1;

        return `${PASSWORD}-${String(asked)}`;
      },
    });
    const { connect } = await linkUp({ adapter, script });

    expect(connect).toMatchObject({
      clean: true,
      clientId: ID,
      keepalive: 2,
      properties: {
        maximumPacketSize: 2_048,
        receiveMaximum: 65_535,
        topicAliasMaximum: 0,
      },
      protocolVersion: 5,
      username: ID,
    });
    expect(String((connect as { password?: Buffer }).password)).toBe(`${PASSWORD}-1`);
    expect(
      (connect as { properties?: { sessionExpiryInterval?: number } }).properties
        ?.sessionExpiryInterval ?? 0
    ).toBe(0);
    expect(adapter.type).toBe(TRANSPORT_MQTT);
    await adapter.stop();

    // * a password asked at each link's start, renewed with each incarnation
    const again = await linkUp({ adapter, script });

    expect(String((again.connect as { password?: Buffer }).password)).toBe(`${PASSWORD}-2`);
    await adapter.stop();

    // under a client certificate its broker ties to its id, over TLS: neither User Name nor
    // Password
    const secured = await createMqttScript({ tls: TLS_FIXTURE });

    try {
      const certified = createMqttBrokerAdapter({
        id: ID,
        tls: { ca: TLS_FIXTURE.cert, cert: TLS_FIXTURE.cert, key: TLS_FIXTURE.key },
        url: secured.url,
      });
      const { connect: bare } = await linkUp({ adapter: certified, script: secured });

      expect(bare).toMatchObject({ clientId: ID, protocolVersion: 5 });
      expect((bare as { username?: string }).username).toBeUndefined();
      expect((bare as { password?: Buffer }).password).toBeUndefined();
      expect(certified.isSecure).toBe(true);
      await certified.stop();
    } finally {
      await secured[Symbol.asyncDispose]();
    }

    // a certificate in the clear is refused as it is built
    expect(() => {
      return createMqttBrokerAdapter({ id: ID, tls: TLS_FIXTURE, url: script.url });
    }).toThrow('a TLS client certificate is carried over mqtts or wss');
  });

  test('fails its start on a CONNACK whose Maximum QoS is 0, naming it (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const limiting = adapter.start();
    const link = await script.link();

    link.send({
      cmd: 'connack',
      properties: { maximumQoS: 0 },
      reasonCode: 0,
      sessionPresent: false,
    });
    await expect(limiting).rejects.toThrow('Maximum QoS 0');
    expect(downs).toEqual([]);

    // * a start that fails sends nothing: no DISCONNECT
    expect(await closedWithin(link)).toBe(true);
    expect(cmdsOf(link)).toEqual(['connect']);

    // a CONNACK that refuses fails it too, naming its reason
    const starting = adapter.start();
    const refused = await script.link();

    refused.send({ cmd: 'connack', reasonCode: 0x86, sessionPresent: false });
    await expect(starting).rejects.toThrow('Bad User Name or Password');

    // and so does no CONNACK within connectTimeout
    const waiting = adapterOf(script, { connectTimeout: 200 });

    await expect(waiting.start()).rejects.toThrow('no CONNACK within 200 ms');
  });

  test('fails its start where its broker cannot be reached, over TCP, TLS or a WebSocket, naming why', async () => {
    // a port no one listens on any more
    const listener = createServer();

    await new Promise<void>((resolve) => {
      listener.listen(0, '127.0.0.1', resolve);
    });

    const { port } = listener.address() as AddressInfo;

    await new Promise((resolve) => {
      listener.close(resolve);
    });

    // * and a host no name resolves to (RFC 6761 §6.4), on the port of its scheme
    for (const url of [
      `mqtt://127.0.0.1:${String(port)}`,
      `mqtts://127.0.0.1:${String(port)}`,
      `ws://127.0.0.1:${String(port)}/mqtt`,
      `wss://127.0.0.1:${String(port)}/mqtt`,
      'mqtt://broker.invalid',
      'mqtts://broker.invalid',
    ]) {
      // * given up within a second, as MQTTnet's own timeout gives the C# side's up, so that a slow
      // resolver fails it rather than the test
      const adapter = adapterOf(script, { connectTimeout: 1_000, url });
      const { downs } = heardOf(adapter);

      await expect(adapter.start()).rejects.toThrow(
        /^the link of ada (ended before its CONNACK|had no CONNACK within 1000 ms)/
      );
      expect([adapter.isLinked, downs]).toEqual([false, []]);
    }
  });

  test('fails its start over TLS where its broker’s certificate chains to no authority it trusts', async () => {
    const secured = await createMqttScript({ tls: TLS_FIXTURE });

    try {
      const untrusting = createMqttBrokerAdapter({
        id: ID,
        tls: { cert: TLS_FIXTURE.cert, key: TLS_FIXTURE.key },
        url: secured.url,
      });

      await expect(untrusting.start()).rejects.toThrow('the link of ada ended before its CONNACK');
      // * no CONNECT went: its broker's certificate was refused before it
      await expect(secured.link({ within: 200 })).rejects.toThrow('no link came');
    } finally {
      await secured[Symbol.asyncDispose]();
    }
  });

  test('keeps a Server Keep Alive shorter than its own: a PINGREQ once nothing went for that long (spec 15.26)', async () => {
    const adapter = adapterOf(script, { keepAlive: 30_000 });
    const link = await linkUp({ adapter, script }, { properties: { serverKeepAlive: 1 } });
    const startedAt = Date.now();

    await link.next('pingreq', { within: 3_000 });
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    link.send({ cmd: 'pingresp' });
    await adapter.stop();
  });

  // spec 15.26, where the sides part: MQTT.js keeps its own under 0 and takes a longer one, where the
  // Rust side sends no PINGREQ under 0 and the C# side keeps its own under both; a row of
  // docs/support.md
  test('keeps its own Keep Alive under a Server Keep Alive of 0, and takes one longer than its own (spec 15.26)', async () => {
    const zero = adapterOf(script, { keepAlive: 1_000 });
    const unbounded = await linkUp(
      { adapter: zero, script },
      { properties: { serverKeepAlive: 0 } }
    );
    let startedAt = Date.now();

    await unbounded.next('pingreq', { within: 3_000 });
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    unbounded.send({ cmd: 'pingresp' });
    await zero.stop();

    const longer = adapterOf(script, { keepAlive: 1_000 });
    const link = await linkUp({ adapter: longer, script }, { properties: { serverKeepAlive: 2 } });

    startedAt = Date.now();
    await expect(link.next('pingreq', { within: 1_500 })).rejects.toThrow();
    await link.next('pingreq', { within: 2_000 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    link.send({ cmd: 'pingresp' });
    await longer.stop();
  });

  test('leaves a will of its GONE, QoS 1, RETAIN 0 and a Will Delay Interval of 0, and stops with a DISCONNECT of 0x00 (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const gone = writeParcel({
      acceptor: new Uint8Array(8),
      id: ID,
      incarnation: new Uint8Array(16).fill(7),
      kind: ParcelKind.GONE,
      opener: new Uint8Array(8),
      sequence: 0,
    });
    const link = await linkUp(
      { adapter, script },
      { will: { payload: gone, topic: ['bead', 'd', ID] } }
    );

    expect((link.connect as { will?: unknown }).will).toMatchObject({
      properties: { willDelayInterval: 0 },
      qos: 1,
      retain: false,
      topic: `bead/d/${ID}`,
    });
    expect(new Uint8Array((link.connect as { will: { payload: Buffer } }).will.payload)).toEqual(
      gone
    );

    const { downs } = heardOf(adapter);
    // what its stop finds unsettled fails, nothing of it left to a later link
    const pending = adapter.subscribe(INBOX).catch((reason: unknown) => {
      return reason;
    });

    await link.next('subscribe');
    // * its SUBSCRIBE under way let go before its DISCONNECT
    expect(await unsubackedOf(link, adapter.stop())).toEqual(['bead/i/ada']);
    expect(await pending).toMatchObject({ message: 'the link of ada stopped' });

    const disconnect = await link.next('disconnect');

    expect((disconnect as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
    await link.closed;
    expect(downs).toEqual([]);
  });

  test('ends a participant’s link with a DISCONNECT of 0x00 when its stop meets its inbox’s SUBSCRIBE (spec 15.21)', async () => {
    const adapter = adapterOf(script);
    const participant = createBrokerParticipant({ adapter, heartbeat: Infinity });
    const starting = failureOf(participant.start());
    const link = await script.link();

    link.send({ cmd: 'connack', properties: {}, reasonCode: 0, sessionPresent: false });
    // * its inbox's SUBSCRIBE left unanswered: its adapter's stop ends it, no signal of the stop
    await link.next('subscribe');
    expect(await unsubackedOf(link, participant.stop())).toEqual(['bead/i/ada']);
    expect(await starting).toMatchObject({ message: 'the participant ada stopped as it started' });

    const disconnect = await link.next('disconnect');

    expect((disconnect as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
    await link.closed;
    expect(
      link.packets.map(({ cmd }) => {
        return cmd;
      })
    ).toEqual(['connect', 'subscribe', 'unsubscribe', 'disconnect']);
  });

  test('tells its link taken over on a DISCONNECT of 0x8E, and lost on any other end (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const first = await linkUp({ adapter, script });

    first.send({ cmd: 'disconnect', reasonCode: 0x8e });
    first.end();
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: true }]);

    // a DISCONNECT of another reason, and a cut, are a link lost
    const second = await linkUp({ adapter, script });

    second.send({ cmd: 'disconnect', reasonCode: 0x95 });
    second.end();
    await until(() => {
      return downs.length > 1;
    });

    const third = await linkUp({ adapter, script });

    third.cut();
    await until(() => {
      return downs.length > 2;
    });
    expect(downs).toEqual([{ isTakenOver: true }, { isTakenOver: false }, { isTakenOver: false }]);
  });

  test('tells its link taken over on a DISCONNECT of 0x8E whatever else it carries, a Session Expiry Interval among it (spec 15.21)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    // * a DISCONNECT of 0x8E, its Session Expiry Interval of 0 and its Reason String "n", which a
    // broker never sends together ([MQTT-3.14.2-2]) and which end its link all the same
    // ([MQTT-3.14.4-2])
    link.write(Uint8Array.of(0xe0, 0x0b, 0x8e, 0x09, 0x11, 0, 0, 0, 0, 0x1f, 0x00, 0x01, 0x6e));
    link.end();
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: true }]);
    expect(adapter.isLinked).toBe(false);
    expect(cmdsOf(link)).toEqual(['connect']);
    await adapter.stop();
  });

  test('subscribes at QoS 1, No Local 0, Retain As Published 0 and Retain Handling 2, a group as its shared subscription, held once its SUBACK grants QoS 1 and refused otherwise (spec 15.27)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    let isHeld = false;
    const subscribing = adapter.subscribe(INBOX).then(() => {
      isHeld = true;
    });
    const subscribe = (await link.next('subscribe')) as ISubscribePacket;

    expect(subscribe.subscriptions).toEqual([
      { nl: false, qos: 1, rap: false, rh: 2, topic: 'bead/i/ada' },
    ]);
    await sleep(50);
    expect(isHeld).toBe(false);
    link.send({ cmd: 'suback', granted: [1], messageId: subscribe.messageId ?? 0, properties: {} });
    await subscribing;

    // * a group's own filter, which its UNSUBSCRIBE names again
    const grouped = adapter.subscribe(NAME, { group: 'interop' });
    const shared = await subackOf(link, 1);

    await grouped;
    expect(shared.subscriptions[0]?.topic).toBe('$share/interop/bead/s/interop');

    const leaving = adapter.unsubscribe(NAME);
    const unsubscribe = await link.next('unsubscribe');

    expect((unsubscribe as { unsubscriptions: string[] }).unsubscriptions).toEqual([
      '$share/interop/bead/s/interop',
    ]);
    link.send({
      cmd: 'unsuback',
      granted: [0],
      messageId: unsubscribe.messageId ?? 0,
      properties: {},
    });
    await leaving;

    // QoS 0 granted is refused, as a failure is
    const downgraded = adapter.subscribe(['bead', 'd', 'bob']);

    await subackOf(link, 0);
    await expect(downgraded).rejects.toThrow('0x00');

    const failed = adapter.subscribe(['bead', 'd', 'eve']);

    await subackOf(link, 0x87);
    await expect(failed).rejects.toThrow('0x87');
    // * its stop lets go of what its broker holds, QoS 0 granted among it, and of nothing refused
    expect(await unsubackedOf(link, adapter.stop())).toEqual(['bead/i/ada', 'bead/d/bob']);
  });

  test('lets a subscription go once its UNSUBACK came, naming the topic itself where it held none, and refuses it on any other code (spec 15.27)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    const answered = async (
      topic: readonly string[],
      code: number
    ): Promise<string | undefined> => {
      const leaving = adapter.unsubscribe(topic);
      const unsubscribe = await link.next('unsubscribe');

      link.send({
        cmd: 'unsuback',
        granted: [code],
        messageId: unsubscribe.messageId ?? 0,
        properties: {},
      });
      await leaving;

      return (unsubscribe as { unsubscriptions: string[] }).unsubscriptions[0];
    };

    // * one its broker held none of is let go all the same, 0x11
    expect(await answered(['bead', 'd', 'bob'], 0x11)).toBe('bead/d/bob');
    expect(await answered(['bead', 'd', 'bob'], 0x00)).toBe('bead/d/bob');

    const subscribing = adapter.subscribe(['bead', 'd', 'eve']);

    await subackOf(link, 1);
    await subscribing;

    // * each refusal MQTT 5 names an UNSUBACK by: MQTT.js's parser hands no code it does not name,
    // refusing a packet of any other, 0x01 among them, which loses its link (spec 15.29)
    for (const code of [0x80, 0x83, 0x87, 0x8f, 0x91]) {
      const refused = `0x${code.toString(16).padStart(2, '0').toUpperCase()}`;

      await expect(answered(['bead', 'd', 'eve'], code), refused).rejects.toThrow(refused);
    }

    // its link kept, and the filter refused its stop's to let go
    expect(adapter.isLinked).toBe(true);
    expect(await unsubackedOf(link, adapter.stop())).toEqual(['bead/d/eve']);
  });

  test('fails an unsubscription whose UNSUBACK has not come within connectTimeout, its link kept and no will gone, then reads the late UNSUBACK (spec 15.27)', async () => {
    const adapter = adapterOf(script, { connectTimeout: 300 });
    const { downs } = heardOf(adapter);
    const link = await linkUp(
      { adapter, script },
      { will: { payload: Uint8Array.of(1), topic: ['bead', 'd', ID] } }
    );
    const other = ['bead', 's', 'other'];

    for (const topic of [NAME, other]) {
      const subscribing = adapter.subscribe(topic);

      await subackOf(link, 1);
      await subscribing;
    }

    // * neither UNSUBACK comes within its connectTimeout: each fails, naming it, its link kept
    const startedAt = Date.now();
    const leaving = [NAME, other].map((topic) => {
      return failureOf(adapter.unsubscribe(topic));
    });
    const unsubscribes = [await link.next('unsubscribe'), await link.next('unsubscribe')];

    for (const failure of await Promise.all(leaving)) {
      expect(failure, 'failed').toBeInstanceOf(GenericError);
      expect(failure, 'naming its connectTimeout').toMatchObject({
        message: expect.stringContaining('within 300 ms, its connectTimeout'),
      });
    }

    expect(Date.now() - startedAt, 'its connectTimeout waited').toBeGreaterThanOrEqual(250);
    expect([adapter.isLinked, link.isClosed, downs], 'its link kept').toEqual([true, false, []]);

    // * the late UNSUBACK of the first read, which lets its filter go; the second's kept for its stop
    link.send({
      cmd: 'unsuback',
      granted: [0],
      messageId: unsubscribes[0]?.messageId ?? 0,
      properties: {},
    });
    await sleep(50);
    expect([adapter.isLinked, link.isClosed], 'read, its link kept').toEqual([true, false]);
    expect(await unsubackedOf(link, adapter.stop()), 'its stop lets the second go').toEqual([
      'bead/s/other',
    ]);
    expect(
      ((await link.next('disconnect')) as { reasonCode?: number }).reasonCode ?? 0,
      'its DISCONNECT, no will'
    ).toBe(0);
    expect(downs, 'no loss told').toEqual([]);
  });

  test('refuses a group once its CONNACK says Shared Subscription Available 0 or its SUBACK 0x9E (spec 15.25)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp(
      { adapter, script },
      { properties: { sharedSubscriptionAvailable: false } }
    );

    await expect(adapter.subscribe(NAME, { group: 'interop' })).rejects.toThrow(
      'no shared subscription'
    );
    await sleep(50);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'subscribe';
      })
    ).toEqual([]);
    await adapter.stop();

    // its SUBACK's 0x9E refuses that group, and every one after it on that link
    const again = await linkUp({ adapter, script });
    const first = adapter.subscribe(NAME, { group: 'interop' });

    await subackOf(again, 0x9e);
    await expect(first).rejects.toThrow('0x9E');
    await expect(adapter.subscribe(NAME, { group: 'interop' })).rejects.toThrow(
      'no shared subscription'
    );
    await adapter.stop();

    // and an adapter told its broker offers none states it, and refuses one as asked
    const none = adapterOf(script, { groups: false });

    expect(none.capabilities.groups).toBe(false);
    expect(adapter.capabilities.groups).toBe(true);
    await expect(none.subscribe(NAME, { group: 'interop' })).rejects.toThrow(ProgrammerError);
  });

  test('publishes at QoS 1 and RETAIN 0, a life in whole seconds rounded up where one is asked, and no other property (spec 15.28)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    const payload = Uint8Array.of(1, 2, 3);

    for (const expiresAfter of [undefined, 1, 1_000, 1_001, 60_000]) {
      const publishing = adapter.publish({
        payload,
        topic: INBOX,
        ...(expiresAfter === undefined ? {} : { expiresAfter }),
      });
      const publish = (await link.next('publish')) as IPublishPacket;

      link.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode: 0 });
      expect(await publishing).toBe(BROKER_PUBLISHED.TAKEN);
      expect({
        payload: [...new Uint8Array(publish.payload as Buffer)],
        properties: publish.properties ?? {},
        qos: publish.qos,
        retain: publish.retain,
        topic: publish.topic,
      }).toEqual({
        payload: [1, 2, 3],
        properties:
          expiresAfter === undefined
            ? {}
            : { messageExpiryInterval: Math.max(1, Math.ceil(expiresAfter / 1_000)) },
        qos: 1,
        retain: false,
        topic: 'bead/i/ada',
      });
    }

    await adapter.stop();

    // at most once, each of QoS 0, which no PUBACK answers
    const quick = adapterOf(script, { delivery: BROKER_DELIVERIES.AT_MOST_ONCE });
    const quickLink = await linkUp({ adapter: quick, script });

    expect([quick.delivery, quick.capabilities.noSubscriber]).toEqual([
      BROKER_DELIVERIES.AT_MOST_ONCE,
      false,
    ]);
    // its bound counts no Packet Identifier, which a QoS 0 PUBLISH has none of
    expect(quick.maximumPayloadBytes(INBOX)).toBe(
      largestPayload('bead/i/ada', LARGEST_PACKET_SIZE, { qos: 0 })
    );
    expect(await quick.publish({ payload, topic: INBOX })).toBe(BROKER_PUBLISHED.TAKEN);
    expect(((await quickLink.next('publish')) as IPublishPacket).qos).toBe(0);
    await quick.stop();
  });

  test('holds its QoS 1 publications to its CONNACK’s Receive Maximum, the next one going once a PUBACK came, and delays no other packet for them (spec 15.28)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script }, { properties: { receiveMaximum: 2 } });
    const publishing = [1, 2, 3, 4, 5].map((index) => {
      return adapter.publish({ payload: Uint8Array.of(index), topic: INBOX });
    });

    await sleep(100);

    const sent = (): IPublishPacket[] => {
      return link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      }) as IPublishPacket[];
    };

    expect(sent()).toHaveLength(2);

    // * a SUBSCRIBE goes past them, its quota none of theirs
    const subscribing = adapter.subscribe(['bead', 'd', 'bob']);

    await subackOf(link, 1);
    await subscribing;
    expect(sent()).toHaveLength(2);

    for (const expected of [3, 4, 5]) {
      const oldest = sent()[expected - 3];

      link.send({ cmd: 'puback', messageId: oldest?.messageId ?? 0, reasonCode: 0 });
      await until(() => {
        return sent().length === expected;
      });
      expect(sent()).toHaveLength(expected);
    }

    for (const publish of sent().slice(3)) {
      link.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode: 0 });
    }

    expect(await Promise.all(publishing)).toEqual(
      publishing.map(() => {
        return BROKER_PUBLISHED.TAKEN;
      })
    );
    expect(
      sent().map(({ payload }) => {
        return new Uint8Array(payload as Buffer)[0];
      })
    ).toEqual([1, 2, 3, 4, 5]);
    expect(await unsubackedOf(link, adapter.stop())).toEqual(['bead/d/bob']);
  });

  // spec 15.24, 15.28
  test('sends what waits on its broker’s Receive Maximum before its stop’s DISCONNECT, within its connectTimeout, and fails what has not gone by then', async () => {
    const adapter = adapterOf(script, { connectTimeout: 1_000 });
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script }, { properties: { receiveMaximum: 1 } });
    const sent = (): IPublishPacket[] => {
      return link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      }) as IPublishPacket[];
    };
    const publishing = [1, 2, 3].map((index) => {
      return adapter.publish({ payload: Uint8Array.of(index), topic: INBOX });
    });

    await until(() => {
      return sent().length === 1;
    });

    // * its stop takes no publication, and sends what waits first, one PUBACK at a time
    const stopping = adapter.stop();
    const refused = await failureOf(adapter.publish({ payload: Uint8Array.of(4), topic: INBOX }));

    expect(refused, 'none taken once it stops').toMatchObject({
      message: 'the link of ada is not up',
    });

    for (const index of [0, 1, 2]) {
      await until(() => {
        return sent().length === index + 1;
      });
      expect(sent(), 'one at a time').toHaveLength(index + 1);
      link.send({ cmd: 'puback', messageId: sent()[index]?.messageId ?? 0, reasonCode: 0 });
    }

    await stopping;
    expect(await Promise.all(publishing), 'each taken').toEqual([
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
    ]);

    const disconnect = await link.next('disconnect');

    expect((disconnect as { reasonCode?: number }).reasonCode ?? 0, 'no will').toBe(0);
    expect(
      link.packets
        .filter(({ cmd }) => {
          return cmd === 'publish' || cmd === 'disconnect';
        })
        .map((packet) => {
          return packet.cmd === 'publish'
            ? new Uint8Array(packet.payload as Buffer)[0]
            : packet.cmd;
        }),
      'each sent before its DISCONNECT'
    ).toEqual([1, 2, 3, 'disconnect']);

    // * its broker answers none: past its connectTimeout, what has not gone fails, and its
    // DISCONNECT goes
    const silent = await linkUp({ adapter, script }, { properties: { receiveMaximum: 1 } });
    const unanswered = [5, 6].map((index) => {
      return failureOf(adapter.publish({ payload: Uint8Array.of(index), topic: INBOX }));
    });

    await silent.next('publish');

    const startedAt = Date.now();

    await adapter.stop();
    expect(Date.now() - startedAt, 'its connectTimeout waited').toBeGreaterThanOrEqual(900);
    expect(await Promise.all(unanswered), 'each failed').toEqual([
      expect.objectContaining({ message: 'the link of ada stopped' }),
      expect.objectContaining({ message: 'the link of ada stopped' }),
    ]);
    expect(
      ((await silent.next('disconnect')) as { reasonCode?: number }).reasonCode ?? 0,
      'its DISCONNECT, no will'
    ).toBe(0);
    expect(
      silent.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      }),
      'the second never sent'
    ).toHaveLength(1);
    expect(downs, 'no loss told').toEqual([]);
  });

  test('lets go at its stop of each subscription its link holds once what it was handed went, one UNSUBSCRIBE per filter sent at once and their UNSUBACKs of 0x00 or 0x11 awaited together, then sends its DISCONNECT of 0x00 (spec 15.24, 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    // * its inbox, a name of its group and a peer's departure
    for (const [topic, group] of [
      [INBOX, undefined],
      [NAME, 'interop'],
      [['bead', 'd', 'bob'], undefined],
    ] as const) {
      const subscribing = adapter.subscribe(topic, group === undefined ? undefined : { group });

      await subackOf(link, 1);
      await subscribing;
    }

    const publishing = adapter.publish({ payload: Uint8Array.of(1), topic: ['bead', 'i', 'bob'] });
    const publish = await link.next('publish');
    const stopping = adapter.stop();
    const sentOf = (cmd: Packet['cmd']): Packet[] => {
      return link.packets.filter((packet) => {
        return packet.cmd === cmd;
      });
    };

    await sleep(100);
    expect(sentOf('unsubscribe'), 'none while what it was handed awaits its PUBACK').toEqual([]);
    link.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode: 0 });
    expect(await publishing).toBe(BROKER_PUBLISHED.TAKEN);

    // * each read before any UNSUBACK is sent: all of them at once
    const unsubscribes = [
      await link.next('unsubscribe'),
      await link.next('unsubscribe'),
      await link.next('unsubscribe'),
    ];

    expect(
      unsubscribes.map((unsubscribe) => {
        return (unsubscribe as { unsubscriptions: string[] }).unsubscriptions;
      }),
      'one filter each'
    ).toEqual([['bead/i/ada'], ['$share/interop/bead/s/interop'], ['bead/d/bob']]);

    // * 0x11, none held, lets one go as 0x00 does
    for (const [index, unsubscribe] of unsubscribes.entries()) {
      await sleep(50);
      expect(sentOf('disconnect'), 'its DISCONNECT once every UNSUBACK came').toEqual([]);
      link.send({
        cmd: 'unsuback',
        granted: [index === 1 ? 0x11 : 0x00],
        messageId: unsubscribe.messageId ?? 0,
        properties: {},
      });
    }

    await stopping;
    expect(((await link.next('disconnect')) as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
    expect(
      link.packets.map(({ cmd }) => {
        return cmd;
      })
    ).toEqual([
      'connect',
      'subscribe',
      'subscribe',
      'subscribe',
      'publish',
      'unsubscribe',
      'unsubscribe',
      'unsubscribe',
      'disconnect',
    ]);
    expect(downs, 'no loss told').toEqual([]);
  });

  test('sends its stop’s DISCONNECT of 0x00 all the same where an UNSUBACK refuses or none comes, what it was handed and its UNSUBACKs awaited within one connectTimeout of its call (spec 15.26, 15.30)', async () => {
    const adapter = adapterOf(script, { connectTimeout: 1_000 });
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    for (const topic of [INBOX, ['bead', 'd', 'bob']]) {
      const subscribing = adapter.subscribe(topic);

      await subackOf(link, 1);
      await subscribing;
    }

    const publishing = adapter.publish({ payload: Uint8Array.of(1), topic: ['bead', 'i', 'bob'] });
    const publish = await link.next('publish');
    const startedAt = Date.now();
    const stopping = adapter.stop();

    // * most of its connectTimeout spent on what it was handed
    await sleep(700);
    link.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode: 0 });
    expect(await publishing).toBe(BROKER_PUBLISHED.TAKEN);

    const refused = await link.next('unsubscribe');

    await link.next('unsubscribe');
    // the second's UNSUBACK withheld
    link.send({
      cmd: 'unsuback',
      granted: [0x80],
      messageId: refused.messageId ?? 0,
      properties: {},
    });
    await stopping;

    const spent = Date.now() - startedAt;

    expect(spent, 'its connectTimeout waited').toBeGreaterThanOrEqual(950);
    expect(spent, 'one connectTimeout from its call, not one after its drain').toBeLessThan(1_500);
    expect(
      ((await link.next('disconnect')) as { reasonCode?: number }).reasonCode ?? 0,
      'its DISCONNECT, no will'
    ).toBe(0);
    expect(downs, 'no loss told').toEqual([]);
  });

  test('lets each filter go at its stop in an UNSUBSCRIBE of its own, none past its CONNACK’s Maximum Packet Size (spec 15.26, 15.27)', async () => {
    const maximumPacketSize = 64;
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script }, { properties: { maximumPacketSize } });
    const departures = ['amy', 'bea', 'cyd', 'dot', 'eve'].map((peer) => {
      return ['bead', 'd', `${peer}-${'x'.repeat(30)}`];
    });

    for (const topic of departures) {
      const subscribing = adapter.subscribe(topic);

      await subackOf(link, 1);
      await subscribing;
    }

    const filters = await unsubackedOf(link, adapter.stop());
    const unsubscribes = link.packets.filter(({ cmd }) => {
      return cmd === 'unsubscribe';
    }) as (Packet & { unsubscriptions: string[] })[];

    expect(filters).toEqual(
      departures.map((topic) => {
        return topic.join('/');
      })
    );
    expect(
      unsubscribes.map(({ unsubscriptions }) => {
        return unsubscriptions.length;
      }),
      'one filter each'
    ).toEqual([1, 1, 1, 1, 1]);

    for (const unsubscribe of unsubscribes) {
      expect(generate(unsubscribe, { protocolVersion: 5 }).length).toBeLessThanOrEqual(
        maximumPacketSize
      );
    }

    // * one packet of them all would pass it, which its broker ends the link for, its will sent
    expect(
      generate(
        { cmd: 'unsubscribe', messageId: 1, properties: {}, unsubscriptions: filters },
        { protocolVersion: 5 }
      ).length
    ).toBeGreaterThan(maximumPacketSize);
  });

  test('lets go at its stop of a filter whose SUBSCRIBE went with no SUBACK yet, its subscription failed (spec 15.27)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    const subscribing = failureOf(adapter.subscribe(NAME, { group: 'interop' }));
    const subscribe = await link.next('subscribe');
    const stopping = adapter.stop();
    const unsubscribe = await link.next('unsubscribe');

    expect((unsubscribe as { unsubscriptions: string[] }).unsubscriptions).toEqual([
      '$share/interop/bead/s/interop',
    ]);
    // * its SUBACK, come behind, holds nothing: its broker read the UNSUBSCRIBE after it
    link.send({ cmd: 'suback', granted: [1], messageId: subscribe.messageId ?? 0, properties: {} });
    link.send({
      cmd: 'unsuback',
      granted: [0],
      messageId: unsubscribe.messageId ?? 0,
      properties: {},
    });
    await stopping;
    expect(await subscribing).toMatchObject({ message: 'the link of ada stopped' });
    expect(((await link.next('disconnect')) as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
  });

  test('keeps a subscription asked again while its UNSUBSCRIBE awaits its UNSUBACK, which its stop then lets go (spec 15.27)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    const subscribing = adapter.subscribe(NAME, { group: 'interop' });

    await subackOf(link, 1);
    await subscribing;

    // * let go, then asked again before that UNSUBACK came
    const leaving = adapter.unsubscribe(NAME);
    const unsubscribe = await link.next('unsubscribe');
    const again = adapter.subscribe(NAME, { group: 'interop' });
    const subscribe = await link.next('subscribe');

    link.send({
      cmd: 'unsuback',
      granted: [0],
      messageId: unsubscribe.messageId ?? 0,
      properties: {},
    });
    link.send({ cmd: 'suback', granted: [1], messageId: subscribe.messageId ?? 0, properties: {} });
    await leaving;
    await again;
    expect(await unsubackedOf(link, adapter.stop())).toEqual(['$share/interop/bead/s/interop']);
  });

  test('sends no UNSUBSCRIBE at its stop ahead of a publication that waits on its broker’s Receive Maximum (spec 15.26, 15.28)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script }, { properties: { receiveMaximum: 2 } });
    const subscribing = adapter.subscribe(INBOX);

    await subackOf(link, 1);
    await subscribing;

    const sent = (): IPublishPacket[] => {
      return link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      }) as IPublishPacket[];
    };
    // * a peer's CLOSE each, as a participant's stop hands them on
    const publishing = [1, 2, 3, 4].map((index) => {
      return adapter.publish({ payload: Uint8Array.of(index), topic: ['bead', 'i', 'bob'] });
    });

    await until(() => {
      return sent().length === 2;
    });

    const stopping = adapter.stop();

    for (const index of [0, 1, 2, 3]) {
      await until(() => {
        return sent().length === Math.min(index + 2, 4);
      });
      await sleep(20);
      expect(
        link.packets.filter(({ cmd }) => {
          return cmd === 'unsubscribe';
        }),
        'none while one waits'
      ).toEqual([]);
      link.send({ cmd: 'puback', messageId: sent()[index]?.messageId ?? 0, reasonCode: 0 });
    }

    expect(await unsubackedOf(link, stopping)).toEqual(['bead/i/ada']);
    expect(await Promise.all(publishing)).toEqual([
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
    ]);
    await link.next('disconnect');
    expect(
      link.packets.map(({ cmd }) => {
        return cmd;
      })
    ).toEqual([
      'connect',
      'subscribe',
      'publish',
      'publish',
      'publish',
      'publish',
      'unsubscribe',
      'disconnect',
    ]);
  });

  test('reads a PUBACK of 0x10 as no subscriber, under 0x80 as taken, and 0x80 or more as refused (spec 15.28)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    const answered = async (reasonCode: number) => {
      const publishing = adapter.publish({ payload: Uint8Array.of(1), topic: NAME });
      const publish = await link.next('publish');

      link.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode });

      return publishing;
    };

    expect(await answered(0x10)).toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    expect(await answered(0x00)).toBe(BROKER_PUBLISHED.TAKEN);
    await expect(answered(0x87)).rejects.toThrow('0x87');
    await expect(answered(0x80)).rejects.toThrow('0x80');
    expect(adapter.capabilities.noSubscriber).toBe(true);
    await adapter.stop();
  });

  test('refuses a publication past its CONNACK’s Maximum Packet Size before it goes (spec 15.28)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script }, { properties: { maximumPacketSize: 1_024 } });
    const room = adapter.maximumPayloadBytes(INBOX);

    // its bound counts a life, whatever the publication
    expect(room).toBe(largestPayload('bead/i/ada', 1_024));

    const fits = adapter.publish({
      expiresAfter: 1_000,
      payload: new Uint8Array(room),
      topic: INBOX,
    });
    const publish = await link.next('publish');

    link.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode: 0 });
    expect(await fits).toBe(BROKER_PUBLISHED.TAKEN);
    await expect(
      adapter.publish({ expiresAfter: 1_000, payload: new Uint8Array(room + 1), topic: INBOX })
    ).rejects.toThrow("past its broker's Maximum Packet Size, 1024 bytes");
    await sleep(50);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      })
    ).toHaveLength(1);
    await adapter.stop();
  });

  test('reports no payload room where its CONNACK’s Maximum Packet Size cannot hold a PUBLISH to the topic, and refuses even an empty publication (spec 15.28)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script }, { properties: { maximumPacketSize: 16 } });

    expect(adapter.maximumPayloadBytes(INBOX)).toBe(0);
    await expect(adapter.publish({ payload: new Uint8Array(), topic: INBOX })).rejects.toThrow(
      "past its broker's Maximum Packet Size, 16 bytes"
    );
    expect(adapter.isLinked).toBe(true);
    await sleep(50);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      })
    ).toHaveLength(0);
    await adapter.stop();
  });

  test('tells its link up once its CONNACK came, and bounds what it publishes by that CONNACK’s Maximum Packet Size, the last link’s while it is down (spec 15.30)', async () => {
    const adapter = adapterOf(script);
    const read = (): [boolean, number] => {
      return [adapter.isLinked, adapter.maximumPayloadBytes(INBOX)];
    };
    const boundOf = (packetSize: number): number | undefined => {
      return largestPayload('bead/i/ada', packetSize);
    };

    // * before any link, what MQTT 5 writes at most
    expect(read()).toEqual([false, boundOf(LARGEST_PACKET_SIZE)]);

    const first = await linkUp({ adapter, script }, { properties: { maximumPacketSize: 1_024 } });

    expect(read()).toEqual([true, boundOf(1_024)]);
    first.cut();
    await until(() => {
      return !adapter.isLinked;
    });

    // the last link's while it is down, and while the next one starts
    expect(read()).toEqual([false, boundOf(1_024)]);

    const starting = adapter.start();
    const second = await script.link();

    expect(read()).toEqual([false, boundOf(1_024)]);
    second.send({ cmd: 'connack', properties: {}, reasonCode: 0, sessionPresent: false });
    await starting;
    expect(read()).toEqual([true, boundOf(LARGEST_PACKET_SIZE)]);
    await adapter.stop();
    expect(read()).toEqual([false, boundOf(LARGEST_PACKET_SIZE)]);
  });

  test('hands each message on before its PUBACK, which goes once it is settled, and once (spec 15.29)', async () => {
    const adapter = adapterOf(script);
    const { messages } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    link.send(publishOf({ messageId: 7, payload: Uint8Array.of(9), topic: 'bead/i/ada' }));
    await until(() => {
      return messages.length > 0;
    });
    expect(
      messages.map(({ payload, topic }) => {
        return { payload: [...payload], topic };
      })
    ).toEqual([{ payload: [9], topic: ['bead', 'i', 'ada'] }]);
    expect(adapter.unsettled).toBe(1);
    await sleep(50);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'puback';
      })
    ).toEqual([]);

    messages[0]?.settle();
    messages[0]?.settle();

    const puback = await link.next('puback');

    expect(puback).toMatchObject({ messageId: 7 });
    expect((puback as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
    expect(adapter.unsettled).toBe(0);
    await sleep(50);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'puback';
      })
    ).toHaveLength(1);
    expect(messages).toHaveLength(1);

    // * one of QoS 0, which no PUBACK answers, handed on with nothing to acknowledge
    link.send(publishOf({ payload: Uint8Array.of(8), qos: 0, topic: 'bead/i/ada' }));
    await until(() => {
      return messages.length > 1;
    });
    messages[1]?.settle();
    expect([[...(messages[1]?.payload ?? [])], adapter.unsettled]).toEqual([[8], 0]);
    await adapter.stop();
  });

  test('drops a message whose RETAIN is 1, acknowledging it (spec 15.29)', async () => {
    const adapter = adapterOf(script);
    const participant = createBrokerParticipant({ adapter, heartbeat: Infinity });
    const errors: Error[] = [];

    participant.on('error', (error) => {
      errors.push(error);
    });

    const starting = participant.start();
    const link = await script.link();

    link.send({ cmd: 'connack', properties: {}, reasonCode: 0, sessionPresent: false });
    await subackOf(link, 1);
    await starting;
    link.send(
      publishOf({ messageId: 3, payload: Uint8Array.of(0xff), retain: true, topic: 'bead/i/ada' })
    );

    const puback = await link.next('puback');

    expect(puback).toMatchObject({ messageId: 3 });
    expect((puback as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
    expect(adapter.unsettled).toBe(0);
    expect(errors).toEqual([]);
    expect(await unsubackedOf(link, participant.stop())).toEqual(['bead/i/ada']);
  });

  test('closes its link, no DISCONNECT, on a packet past its own Maximum Packet Size, read at its length (spec 15.29)', async () => {
    const adapter = adapterOf(script, { maximumPacketSize: 1_100 });
    const { downs, messages } = heardOf(adapter);
    const isClosedIn = async (link: IScriptedLink): Promise<void> => {
      expect(await closedWithin(link)).toBe(true);
      expect(
        link.packets.filter(({ cmd }) => {
          return cmd === 'disconnect' || cmd === 'puback';
        })
      ).toEqual([]);
    };

    // (a) a PUBLISH of 1,118 bytes in all, whole, after its CONNACK
    const whole = await linkUp({ adapter, script });

    whole.send(publishOf({ messageId: 1, payload: new Uint8Array(1_100), topic: 'bead/i/ada' }));
    await isClosedIn(whole);
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: false }]);

    // * (b) a fixed header alone announcing 16,777,221 bytes: judged at its length, no body awaited
    const announced = await linkUp({ adapter, script });

    announced.write(Uint8Array.of(0x32, 0x80, 0x80, 0x80, 0x08));
    await isClosedIn(announced);
    await until(() => {
      return downs.length > 1;
    });
    expect(downs).toEqual([{ isTakenOver: false }, { isTakenOver: false }]);

    // (c) its CONNACK's fixed header alone announcing as much: its start fails, no down told
    const starting = failureOf(adapter.start());
    const early = await script.link();

    early.write(Uint8Array.of(0x20, 0x80, 0x80, 0x80, 0x08));
    expect(await starting).toMatchObject({
      message: expect.stringContaining('past its Maximum Packet Size'),
    });
    await isClosedIn(early);
    await sleep(50);
    expect(downs).toEqual([{ isTakenOver: false }, { isTakenOver: false }]);
    expect(messages).toEqual([]);
    expect(adapter.isLinked).toBe(false);
  });

  test('loses its link, no DISCONNECT, on a packet its client cannot read (spec 15.29)', async () => {
    const adapter = adapterOf(script);
    const { downs, messages } = heardOf(adapter);
    // * a PUBLISH to its inbox carrying a property MQTT 5 does not define, 0x7F, and a Remaining
    // Length still continuing at its fourth byte (MQTT 5.0 §2.2.2.2, §1.5.5)
    const unreadable = [0x30, 0x0f, 0x00, 0x0a, ...Buffer.from('bead/i/ada'), 0x02, 0x7f, 0x00];
    const isLostIn = async (link: IScriptedLink, count: number): Promise<void> => {
      expect(await closedWithin(link)).toBe(true);
      await until(() => {
        return downs.length >= count;
      });
      expect(downs).toEqual(
        Array.from({ length: count }, () => {
          return { isTakenOver: false };
        })
      );
      expect(adapter.isLinked).toBe(false);
      expect(cmdsOf(link)).toEqual(['connect']);
    };

    for (const [index, bytes] of [unreadable, [0x30, 0xff, 0xff, 0xff, 0xff, 0x01]].entries()) {
      const link = await linkUp({ adapter, script });

      link.write(Uint8Array.from(bytes));
      await isLostIn(link, index + 1);
    }

    // ! MQTT.js's parser tells its refusal ahead of the CONNACK before it in one read, which
    // MQTT.js handles after: its start succeeds, and its link is lost once
    await withClients(async (clients) => {
      const starting = failureOf(adapter.start());
      const link = await script.link();
      const bytes = [...CONNACK_BYTES, ...unreadable];

      expect(clients[0]).toBeDefined();

      const pushed = oneReadOf(clients[0]!, bytes);

      link.write(Uint8Array.from(bytes));
      expect(await starting).toBeUndefined();
      await isLostIn(link, 3);
      expect(pushed.reads).toBe(1);
    });
    expect(messages).toEqual([]);
    await adapter.stop();
  });

  test('loses its link once on a packet past its Maximum Packet Size beside its CONNACK in one read (spec 15.29)', async () => {
    const adapter = adapterOf(script, { maximumPacketSize: 1_100 });
    const { downs, messages } = heardOf(adapter);
    const connect = MqttClient.prototype.connect;
    const clients: MqttClient[] = [];
    const hooked = mock.method(MqttClient.prototype, 'connect', function (this: MqttClient) {
      clients.push(this);

      return connect.call(this);
    });

    try {
      const starting = failureOf(adapter.start());
      const link = await script.link();

      const client = clients[0];

      expect(client).toBeDefined();

      const stream = client!.stream;
      const push = stream.push.bind(stream);
      const bytes = Buffer.from([0x20, 0x03, 0, 0, 0, 0x32, 0x80, 0x80, 0x80, 0x08]);
      let received = Buffer.alloc(0);
      let reads = 0;

      // * one read at the guard, whatever chunks TCP hands the test's receiving seam
      stream.push = (chunk: Buffer | null): boolean => {
        if (chunk === null) {
          return push(null);
        }

        received = Buffer.concat([received, chunk]);

        if (received.length < bytes.length) {
          return true;
        }

        expect(received).toEqual(bytes);
        reads += 1;

        return push(received);
      };
      link.write(bytes);
      expect(await closedWithin(link)).toBe(true);
      const failure = await starting;

      expect(reads).toBe(1);
      expect(failure).toBeUndefined();
      expect(downs).toEqual([{ isTakenOver: false }]);
      expect(messages).toEqual([]);
      expect(adapter.isLinked).toBe(false);
      expect(
        link.packets.map(({ cmd }) => {
          return cmd;
        })
      ).toEqual(['connect']);
      await adapter.stop();
    } finally {
      hooked.mock.restore();
      await adapter.stop();
    }
  });

  test('loses its link once on a packet past its Maximum Packet Size after its CONNACK before its caller resumes (spec 15.29)', async () => {
    const adapter = adapterOf(script, { maximumPacketSize: 1_100 });
    const { downs, messages } = heardOf(adapter);
    const connect = MqttClient.prototype.connect;
    const clients: MqttClient[] = [];
    const hooked = mock.method(MqttClient.prototype, 'connect', function (this: MqttClient) {
      clients.push(this);

      return connect.call(this);
    });

    try {
      const start = { isSettled: false };
      const starting = failureOf(
        adapter.start().finally(() => {
          start.isSettled = true;
        })
      );
      const link = await script.link();

      const client = clients[0];

      expect(client).toBeDefined();

      const held = client!;
      const stream = held.stream;
      const push = stream.push.bind(stream);
      // * a CONNACK of 0x00 whose Maximum Packet Size (0x27) is 1,024 bytes, then the header
      const bytes = Buffer.from([
        0x20, 0x08, 0, 0, 0x05, 0x27, 0, 0, 0x04, 0, 0x32, 0x80, 0x80, 0x80, 0x08,
      ]);
      let received = Buffer.alloc(0);
      let isBetween = false;

      // * the broker's header waits at the receiving seam for MQTT.js's accepted CONNACK;
      // its connect listeners run before the adapter's start settles, its link up already
      held.once('connect', () => {
        expect(held.connected).toBe(true);
        expect(start.isSettled).toBe(false);
        expect(adapter.isLinked).toBe(true);
        isBetween = true;
        push(received.subarray(10));
      });
      stream.push = (chunk: Buffer | null): boolean => {
        if (chunk === null) {
          return push(null);
        }

        received = Buffer.concat([received, chunk]);

        if (received.length < bytes.length) {
          return true;
        }

        expect(received).toEqual(bytes);

        return push(received.subarray(0, 10));
      };
      link.write(bytes);
      expect(await closedWithin(link)).toBe(true);
      const failure = await starting;

      expect(isBetween).toBe(true);
      expect(failure).toBeUndefined();
      expect(downs).toEqual([{ isTakenOver: false }]);
      expect(messages).toEqual([]);
      expect(adapter.isLinked).toBe(false);
      expect(adapter.maximumPayloadBytes(INBOX)).toBe(largestPayload('bead/i/ada', 1_024));
      expect(
        link.packets.map(({ cmd }) => {
          return cmd;
        })
      ).toEqual(['connect']);
    } finally {
      hooked.mock.restore();
      await adapter.stop();
    }
  });

  test('loses its link once as its network connection ends after its CONNACK before its caller resumes (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs, messages } = heardOf(adapter);

    await withClients(async (clients) => {
      try {
        const start = { isSettled: false };
        const starting = failureOf(
          adapter.start().finally(() => {
            start.isSettled = true;
          })
        );
        const link = await script.link();
        const held = clients[0];
        let isBetween = false;

        expect(held).toBeDefined();
        // * its network connection ends as MQTT.js's connect listeners run, its start unsettled
        held!.once('connect', () => {
          expect(start.isSettled).toBe(false);
          isBetween = true;
          held!.stream.destroy();
        });
        link.send({ cmd: 'connack', properties: {}, reasonCode: 0, sessionPresent: false });
        expect(await closedWithin(link)).toBe(true);
        expect(await starting).toBeUndefined();
        await until(() => {
          return downs.length > 0;
        });
        await sleep(50);
        expect(isBetween).toBe(true);
        expect(downs).toEqual([{ isTakenOver: false }]);
        expect(messages).toEqual([]);
        expect(adapter.isLinked).toBe(false);
        expect(cmdsOf(link)).toEqual(['connect']);
      } finally {
        await adapter.stop();
      }
    });
  });

  test('fails its start on a CONNACK that refuses or says Maximum QoS 0 beside a packet past its Maximum Packet Size in one read, naming the CONNACK (spec 15.26, 15.29)', async () => {
    const answers = [
      { connack: [0x20, 0x03, 0x00, 0x86, 0x00], named: 'CONNACK 0x86' },
      { connack: [0x20, 0x03, 0x00, 0x01, 0x00], named: 'CONNACK 0x01' },
      // * its properties a Maximum QoS (0x24) of 0
      { connack: [0x20, 0x05, 0x00, 0x00, 0x02, 0x24, 0x00], named: 'Maximum QoS 0' },
    ];

    await withClients(async (clients) => {
      for (const [index, { connack, named }] of answers.entries()) {
        const adapter = adapterOf(script, { maximumPacketSize: 1_100 });
        const { downs, messages } = heardOf(adapter);

        try {
          const starting = failureOf(adapter.start());
          const link = await script.link();
          const client = clients[index];
          const bytes = [...connack, ...PAST_BYTES];

          expect(client).toBeDefined();

          const pushed = oneReadOf(client!, bytes);

          link.write(Uint8Array.from(bytes));

          const failure = await starting;

          expect(await closedWithin(link)).toBe(true);
          expect(pushed.reads).toBe(1);
          expect(failure).toBeInstanceOf(GenericError);
          expect((failure as Error).message).toContain(named);
          expect((failure as Error).message).not.toContain('past its Maximum Packet Size');
          await sleep(50);
          expect(downs).toEqual([]);
          expect(messages).toEqual([]);
          expect(adapter.isLinked).toBe(false);
          expect(cmdsOf(link)).toEqual(['connect']);
        } finally {
          await adapter.stop();
        }
      }
    });
  });

  test('stops its link with a DISCONNECT of 0x00 after its CONNACK before its caller resumes, its start succeeding and no down told (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);

    await withClients(async (clients) => {
      try {
        const start = { isSettled: false };
        const starting = failureOf(
          adapter.start().finally(() => {
            start.isSettled = true;
          })
        );
        const link = await script.link();
        const held = clients[0];
        const stop: { stopping?: Promise<void> } = {};

        expect(held).toBeDefined();
        // * its stop as MQTT.js's connect listeners run, its start unsettled
        held!.once('connect', () => {
          expect(start.isSettled).toBe(false);
          stop.stopping = adapter.stop();
        });
        link.send({ cmd: 'connack', properties: {}, reasonCode: 0, sessionPresent: false });
        expect(await starting).toBeUndefined();
        expect(stop.stopping).toBeDefined();
        await stop.stopping;

        const disconnect = await link.next('disconnect');

        expect((disconnect as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
        expect(await closedWithin(link)).toBe(true);
        await sleep(50);
        expect(downs).toEqual([]);
        expect(adapter.isLinked).toBe(false);
        expect(cmdsOf(link)).toEqual(['connect', 'disconnect']);
      } finally {
        await adapter.stop();
      }
    });
  });

  test('takes a start from its down’s listener once its link is lost beside its CONNACK (spec 15.26)', async () => {
    const adapter = adapterOf(script, { maximumPacketSize: 1_100 });
    const { downs } = heardOf(adapter);
    const restart: { failure?: Promise<unknown> } = {};

    // * synchronously, as its down is told
    adapter.on('down', () => {
      restart.failure ??= failureOf(adapter.start());
    });

    await withClients(async (clients) => {
      try {
        const starting = failureOf(adapter.start());
        const link = await script.link();
        const client = clients[0];
        const bytes = [...CONNACK_BYTES, ...PAST_BYTES];

        expect(client).toBeDefined();
        oneReadOf(client!, bytes);
        link.write(Uint8Array.from(bytes));
        expect(await starting).toBeUndefined();
        await until(() => {
          return downs.length > 0;
        });
        expect(downs).toEqual([{ isTakenOver: false }]);
        expect(restart.failure).toBeDefined();

        // * its restart taken, not refused as up already: a second link comes, its CONNECT read
        const second = await script.link();

        expect(second.connect.cmd).toBe('connect');
        await adapter.stop();

        const failure = await restart.failure;

        expect(failure).not.toBeInstanceOf(ProgrammerError);
        expect(String(failure)).not.toContain('up already');
      } finally {
        await adapter.stop();
      }
    });
  });

  test('tells its link taken over, its start succeeding, on a DISCONNECT of 0x8E beside its CONNACK in one read (spec 15.21, 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);

    await withClients(async (clients) => {
      try {
        const starting = failureOf(adapter.start());
        const link = await script.link();
        const client = clients[0];
        // * a DISCONNECT of 0x8E, Session taken over, no property
        const bytes = [...CONNACK_BYTES, 0xe0, 0x02, 0x8e, 0x00];

        expect(client).toBeDefined();

        const pushed = oneReadOf(client!, bytes);

        link.write(Uint8Array.from(bytes));
        expect(await starting).toBeUndefined();
        link.end();
        expect(await closedWithin(link)).toBe(true);
        await until(() => {
          return downs.length > 0;
        });
        await sleep(50);
        expect(pushed.reads).toBe(1);
        expect(downs).toEqual([{ isTakenOver: true }]);
        expect(adapter.isLinked).toBe(false);
        expect(cmdsOf(link)).toEqual(['connect']);
      } finally {
        await adapter.stop();
      }
    });
  });

  test('announces as its receive bound the largest payload of a message to its inbox within its Maximum Packet Size, a life counted (spec 15.30)', () => {
    expect(adapterOf(script).receiveBound(['bead', 'i', 'server'])).toBe(16_777_188);
    expect(
      adapterOf(script, { maximumPacketSize: 4_096 }).receiveBound(['bead', 'i', 'peer'])
    ).toBe(4_072);
    // * a topic whose PUBLISH alone passes the bound leaves no payload any room
    expect(
      adapterOf(script, { maximumPacketSize: 4_096 }).receiveBound(['bead', 'i', 'p'.repeat(4_096)])
    ).toBe(0);
    expect(MAXIMUM_PACKET_SIZE).toBe(16_777_216);

    // a bound whose receive bound is under 1,024 is refused as its participant is built, and one
    // past what MQTT 5 writes as the adapter is
    expect(() => {
      return createBrokerParticipant({ adapter: adapterOf(script, { maximumPacketSize: 1_000 }) });
    }).toThrow("a participant's inbox takes a parcel of 1,024 bytes at least");
    expect(() => {
      return adapterOf(script, { maximumPacketSize: 268_435_461 });
    }).toThrow(ProgrammerError);
  });

  test('tells its link lost once, and nothing of a lost link reaches the next: no message, no acknowledgement, no PUBACK’s reason, no quota (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs, messages } = heardOf(adapter);
    const first = await linkUp({ adapter, script }, { properties: { receiveMaximum: 1 } });

    first.send(publishOf({ messageId: 5, payload: Uint8Array.of(1), topic: 'bead/i/ada' }));
    await until(() => {
      return messages.length > 0;
    });

    const pending = adapter.publish({ payload: Uint8Array.of(1), topic: INBOX });
    const waiting = adapter.publish({ payload: Uint8Array.of(2), topic: INBOX });
    const sent = await first.next('publish');

    first.cut();
    await expect(pending).rejects.toThrow(GenericError);
    await expect(waiting).rejects.toThrow(GenericError);
    await until(() => {
      return downs.length > 0;
    });
    await sleep(50);
    expect(downs).toEqual([{ isTakenOver: false }]);

    // * the next link's quota is its own, and the former's message is acknowledged on none
    const second = await linkUp({ adapter, script }, { properties: { receiveMaximum: 1 } });

    messages[0]?.settle();
    expect(adapter.unsettled).toBe(0);
    // a PUBACK of the former's packet identifier taken as no reason of the next
    second.send({ cmd: 'puback', messageId: sent.messageId ?? 0, reasonCode: 0x10 });

    const next = adapter.publish({ payload: Uint8Array.of(3), topic: INBOX });
    const publish = await second.next('publish');

    second.send({ cmd: 'puback', messageId: publish.messageId ?? 0, reasonCode: 0 });
    expect(await next).toBe(BROKER_PUBLISHED.TAKEN);
    await sleep(50);
    expect(
      second.packets.filter(({ cmd }) => {
        return cmd === 'puback';
      })
    ).toEqual([]);
    expect(downs).toHaveLength(1);

    // a listener let go hears no loss after
    const later: IBrokerDown[] = [];
    const listener = (down: IBrokerDown): void => {
      later.push(down);
    };

    adapter.on('down', listener);
    adapter.off('down', listener);
    second.cut();
    await until(() => {
      return downs.length > 1;
    });
    expect(later).toEqual([]);
  });

  test('refuses what is asked while its link is down, and leaves no library to reconnect, subscribe again or hold a publication (spec 15.26)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);

    await expect(adapter.publish({ payload: Uint8Array.of(1), topic: INBOX })).rejects.toThrow(
      'the link of ada is not up'
    );
    await expect(adapter.subscribe(INBOX)).rejects.toThrow('the link of ada is not up');
    await expect(adapter.unsubscribe(INBOX)).rejects.toThrow('the link of ada is not up');

    const link = await linkUp({ adapter, script });
    const subscribing = adapter.subscribe(INBOX);

    // one link at a time: a start of a link up is refused
    await expect(adapter.start()).rejects.toThrow('the link of ada is up already');
    await subackOf(link, 1);
    await subscribing;
    link.cut();
    await until(() => {
      return downs.length > 0;
    });
    await expect(adapter.publish({ payload: Uint8Array.of(1), topic: INBOX })).rejects.toThrow(
      'the link of ada is not up'
    );

    // no link comes of its own, and the next one subscribes nothing nor sends what was refused
    await expect(script.link({ within: 1_500 })).rejects.toThrow('no link came');

    const next = await linkUp({ adapter, script });

    await sleep(100);
    expect(
      next.packets.map(({ cmd }) => {
        return cmd;
      })
    ).toEqual(['connect']);
    await adapter.stop();
  });

  test('gives up a start, a subscription or a publication its signal aborts, a publication that waits on its quota leaving it unsent, and retires its link where what it asked may have gone', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const given = new AbortController();
    const starting = adapter.start({ signal: given.signal });

    await script.link();
    given.abort();
    await expect(starting).rejects.toThrow();
    expect(downs).toEqual([]);
    await expect(adapter.start({ signal: AbortSignal.abort() })).rejects.toThrow();

    // * its signal, or its stop, as its CONNACK is read, ahead of the adapter's own judgment: that
    // CONNACK puts no link up, and no down is told
    await withClients(async (clients) => {
      const connack: Packet = {
        cmd: 'connack',
        properties: {},
        reasonCode: 0,
        sessionPresent: false,
      };
      const aborted = new AbortController();
      const abortedStart = failureOf(adapter.start({ signal: aborted.signal }));
      const abortedLink = await script.link();

      clients[0]?.prependListener('packetreceive', () => {
        aborted.abort();
      });
      abortedLink.send(connack);
      expect(await abortedStart).toBeInstanceOf(CancelError);

      const stop: { stopping?: Promise<void> } = {};
      const stoppedStart = failureOf(adapter.start());
      const stoppedLink = await script.link();

      clients[1]?.prependListener('packetreceive', () => {
        stop.stopping ??= adapter.stop();
      });
      stoppedLink.send(connack);
      expect(String(await stoppedStart)).toContain('the link of ada stopped as it started');
      await stop.stopping;

      // * a start that fails sends nothing: no DISCONNECT (spec 15.26)
      for (const link of [abortedLink, stoppedLink]) {
        expect(await closedWithin(link)).toBe(true);
        expect(cmdsOf(link)).toEqual(['connect']);
      }
    });
    expect([downs, adapter.isLinked]).toEqual([[], false]);

    // a stop before its CONNACK ends the start, and one as it asks its password, too
    const stoppedEarly = adapter.start();

    await script.link();
    await adapter.stop();
    await expect(stoppedEarly).rejects.toThrow('before its CONNACK');

    const asking = Promise.withResolvers<string>();
    const asked = adapterOf(script, {
      passwordProvider: () => {
        return asking.promise;
      },
    });
    const askedStart = asked.start();

    await asked.stop();
    asking.resolve(PASSWORD);
    await expect(askedStart).rejects.toThrow('the link of ada stopped as it started');

    const link = await linkUp({ adapter, script }, { properties: { receiveMaximum: 1 } });
    const first = adapter.publish({ payload: Uint8Array.of(1), topic: INBOX });
    const leaving = new AbortController();
    const waiting = adapter.publish({
      payload: Uint8Array.of(2),
      signal: leaving.signal,
      topic: INBOX,
    });

    await link.next('publish');
    leaving.abort();
    await expect(waiting).rejects.toThrow();

    // * its link kept: the first still awaits its PUBACK, and the next goes after it
    const sent = link.packets.filter(({ cmd }) => {
      return cmd === 'publish';
    });

    link.send({ cmd: 'puback', messageId: sent[0]?.messageId ?? 0, reasonCode: 0 });
    expect(await first).toBe(BROKER_PUBLISHED.TAKEN);
    await sleep(50);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      })
    ).toHaveLength(1);
    expect(downs).toEqual([]);

    // a subscription given up once its SUBSCRIBE went retires its link
    const cancelled = new AbortController();
    const subscribing = adapter.subscribe(INBOX, { signal: cancelled.signal });

    await link.next('subscribe');
    cancelled.abort();
    await expect(subscribing).rejects.toThrow();
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: false }]);
    await link.closed;

    // and a signal aborted already sends nothing
    const again = await linkUp({ adapter, script });

    await expect(adapter.subscribe(INBOX, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(
      adapter.publish({ payload: Uint8Array.of(1), signal: AbortSignal.abort(), topic: INBOX })
    ).rejects.toThrow();
    await sleep(50);
    expect(
      again.packets.map(({ cmd }) => {
        return cmd;
      })
    ).toEqual(['connect']);

    // and a publication given up once its PUBLISH went retires its link, too
    const abandoned = new AbortController();
    const publishing = adapter.publish({
      payload: Uint8Array.of(3),
      signal: abandoned.signal,
      topic: INBOX,
    });

    await again.next('publish');
    abandoned.abort();
    await expect(publishing).rejects.toThrow();
    await until(() => {
      return downs.length > 1;
    });
    expect(downs).toEqual([{ isTakenOver: false }, { isTakenOver: false }]);
    await again.closed;
    await adapter.stop();
  });

  test('retires its link where a publication at most once is given up before its packet is written (spec 15.28)', async () => {
    const adapter = adapterOf(script, { delivery: BROKER_DELIVERIES.AT_MOST_ONCE });
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script });
    const payload = new Uint8Array(1_048_576);
    const held: Promise<unknown>[] = [];

    link.pause();

    // * far past what its network connection holds unread, each asked in a turn of its own: MQTT.js
    // corks its stream for a turn, and Windows takes one write whole whatever its size
    for (let index = 0; index < 64; index += 1) {
      held.push(
        adapter.publish({ payload, topic: INBOX }).then(
          (published) => {
            return published;
          },
          (error: unknown) => {
            return String(error);
          }
        )
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    const signal = new AbortController();
    const outcome = { isSettled: false };
    const givenUp = failureOf(
      adapter.publish({ payload: Uint8Array.of(1), signal: signal.signal, topic: INBOX })
    ).finally(() => {
      outcome.isSettled = true;
    });

    await sleep(100);
    expect(outcome.isSettled, 'held behind what is not written').toBe(false);
    signal.abort();
    expect(await givenUp).toBeInstanceOf(CancelError);

    // * it may go yet, so its link goes
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: false }]);

    for (const each of await Promise.all(held)) {
      if (each !== BROKER_PUBLISHED.TAKEN) {
        expect(each).toContain(
          'the link of ada was retired: what it was asked was given up once it may have gone'
        );
      }
    }

    // * its network connection closed, no DISCONNECT: what waited never written whole
    link.resume();
    expect(await closedWithin(link)).toBe(true);
    expect(cmdsOf(link)).not.toContain('disconnect');
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'publish';
      }).length
    ).toBeLessThan(64);
    await adapter.stop();
  });

  test('ends its start once stopped in the microtask after its password is answered and asks anew at its next start', async () => {
    let asks = 0;
    const adapter = adapterOf(script, {
      passwordProvider: () => {
        asks += 1;

        if (asks === 1) {
          queueMicrotask(() => {
            queueMicrotask(() => {
              void adapter.stop();
            });
          });
        }

        return PASSWORD;
      },
    });

    await expect(adapter.start()).rejects.toThrow('the link of ada stopped as it started');
    expect(adapter.isLinked).toBe(false);
    await linkUp({ adapter, script });
    expect([asks, adapter.isLinked]).toEqual([2, true]);
    await adapter.stop();
  });

  test('fails its start once its password provider outlives its connect timeout, and takes no late answer', async () => {
    const late = Promise.withResolvers<string>();
    const adapter = adapterOf(script, {
      connectTimeout: 200,
      passwordProvider: () => {
        return late.promise;
      },
    });
    const { downs } = heardOf(adapter);
    const error = await failureOf(adapter.start());

    expect(error).toBeInstanceOf(GenericError);
    expect((error as Error).message).toBe(
      'the link of ada had no password within 200 ms, its connectTimeout'
    );

    // * its answer, come too late, opens no network connection
    late.resolve(PASSWORD);
    await expect(script.link({ within: 300 })).rejects.toThrow('no link came');
    expect([adapter.isLinked, downs]).toEqual([false, []]);

    // * one connectTimeout from its start's call: its CONNACK waits what its ask left of it
    const slow = adapterOf(script, {
      connectTimeout: 600,
      passwordProvider: async () => {
        await sleep(450);

        return PASSWORD;
      },
    });
    const began = performance.now();
    const waiting = failureOf(slow.start());

    await script.link();
    expect(String(await waiting)).toContain(
      'the link of ada had no CONNACK within 600 ms, its connectTimeout'
    );
    expect(performance.now() - began).toBeLessThan(900);
  });

  test('ends its start once stopped as its password is asked, and links at the next start, asked anew', async () => {
    let asked = 0;
    const adapter = adapterOf(script, {
      passwordProvider: () => {
        asked += 1;

        // * the first ask never answers, nor hears its signal
        return asked === 1
          ? new Promise<string>(() => {
              // it never settles
            })
          : `${PASSWORD}-${String(asked)}`;
      },
    });
    const starting = failureOf(adapter.start());

    await until(() => {
      return asked === 1;
    });
    await adapter.stop();

    const error = await starting;

    expect(error).toBeInstanceOf(GenericError);
    expect((error as Error).message).toBe('the link of ada stopped as it started');
    await expect(script.link({ within: 200 })).rejects.toThrow('no link came');

    const { connect } = await linkUp({ adapter, script });

    expect(String((connect as { password?: Buffer }).password)).toBe(`${PASSWORD}-2`);
    expect([asked, adapter.isLinked]).toEqual([2, true]);
    await adapter.stop();
  });

  test('ends its start at its own cancellation as its password is asked', async () => {
    const signals: AbortSignal[] = [];
    const adapter = adapterOf(script, {
      passwordProvider: ({ signal }) => {
        signals.push(signal);

        return new Promise<string>(() => {
          // it never settles
        });
      },
    });
    const given = new AbortController();
    const starting = failureOf(adapter.start({ signal: given.signal }));

    await until(() => {
      return signals.length === 1;
    });
    expect(signals[0]?.aborted).toBe(false);
    given.abort();
    expect(await starting).toBeInstanceOf(CancelError);
    // * its provider's signal aborted with it
    expect(signals[0]?.aborted).toBe(true);
    await expect(script.link({ within: 200 })).rejects.toThrow('no link came');

    // and a signal aborted already asks nothing
    expect(await failureOf(adapter.start({ signal: AbortSignal.abort() }))).toBeInstanceOf(
      CancelError
    );
    expect(signals).toHaveLength(1);
  });

  test('fails its start when its password provider throws, its throw the cause', async () => {
    const thrown = new Error('the vault is down');

    // * as it is called, or as it answers
    for (const passwordProvider of [
      (): string => {
        throw thrown;
      },
      (): Promise<string> => {
        return Promise.reject(thrown);
      },
    ]) {
      const adapter = adapterOf(script, { passwordProvider });
      const error = await failureOf(adapter.start());

      expect(error).toBeInstanceOf(GenericError);
      expect(error).toMatchObject({ cause: thrown, message: 'the password provider failed' });
      expect(adapter.isLinked).toBe(false);
    }

    await expect(script.link({ within: 200 })).rejects.toThrow('no link came');
  });

  test('refuses a password that is empty or holds a NUL, as built or as answered', async () => {
    const refusal = 'a password is a non-empty string holding no NUL';

    for (const password of ['', `${PASSWORD}\0`]) {
      const built = refusalOf(() => {
        return createMqttBrokerAdapter({ id: ID, password, url: script.url });
      });

      expect(built).toBeInstanceOf(ProgrammerError);
      expect((built as Error).message).toBe(refusal);

      const answered = await failureOf(
        adapterOf(script, {
          passwordProvider: () => {
            return password;
          },
        }).start()
      );

      expect(answered).toBeInstanceOf(ProgrammerError);
      expect((answered as Error).message).toBe(refusal);
    }

    // * and an answer that is no string: none is never taken for no password
    const unanswered = await failureOf(
      adapterOf(script, {
        passwordProvider: () => {
          return undefined as unknown as string;
        },
      }).start()
    );

    expect(unanswered).toBeInstanceOf(ProgrammerError);
    expect((unanswered as Error).message).toBe(refusal);
    await expect(script.link({ within: 200 })).rejects.toThrow('no link came');
  });

  test('aborts its password provider’s signal once its start ends, linked or not', async () => {
    const signals: AbortSignal[] = [];
    const adapter = adapterOf(script, {
      passwordProvider: ({ signal }) => {
        signals.push(signal);

        return PASSWORD;
      },
    });
    const starting = adapter.start();
    const link = await script.link();

    // * live while its start is under way
    expect(signals[0]?.aborted).toBe(false);
    link.send({ cmd: 'connack', properties: {}, reasonCode: 0, sessionPresent: false });
    await starting;
    await until(() => {
      return signals[0]?.aborted === true;
    });
    expect([signals[0]?.aborted, adapter.isLinked]).toEqual([true, true]);
    await adapter.stop();

    // and a start its CONNACK refuses
    const refusing = failureOf(adapter.start());
    const refused = await script.link();

    refused.send({ cmd: 'connack', reasonCode: 0x86, sessionPresent: false });
    expect(String(await refusing)).toContain('Bad User Name or Password');
    await until(() => {
      return signals[1]?.aborted === true;
    });
    expect(
      signals.map(({ aborted }) => {
        return aborted;
      })
    ).toEqual([true, true]);
  });

  test('refuses a password beside a client certificate, and both a password and its provider', async () => {
    const secured = 'mqtts://127.0.0.1:8883';
    const provider = (): string => {
      return PASSWORD;
    };
    const refusals = [
      { password: PASSWORD, tls: TLS_FIXTURE },
      { passwordProvider: provider, tls: TLS_FIXTURE },
      { password: PASSWORD, passwordProvider: provider },
      // * both, and a certificate: the first refusal, in one order on every side
      { password: PASSWORD, passwordProvider: provider, tls: TLS_FIXTURE },
    ].map((given) => {
      const refusal = refusalOf(() => {
        return createMqttBrokerAdapter({ id: ID, url: secured, ...given });
      });

      expect(refusal).toBeInstanceOf(ProgrammerError);

      return (refusal as Error).message;
    });

    expect(refusals).toEqual([
      'a link authenticates by its client certificate or by a password, not both',
      'a link authenticates by its client certificate or by a password, not both',
      'a link takes a password or a password provider, not both',
      'a link takes a password or a password provider, not both',
    ]);

    // neither: its User Name, its id, with no Password
    const bare = createMqttBrokerAdapter({ id: ID, url: script.url });
    const { connect } = await linkUp({ adapter: bare, script });

    expect((connect as { username?: string }).username).toBe(ID);
    expect((connect as { password?: Buffer }).password).toBeUndefined();
    await bare.stop();
  });

  test('refuses a TLS client certificate in a page, whose browser chooses it', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');

    Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });

    try {
      expect(() => {
        return createMqttBrokerAdapter({
          id: ID,
          tls: TLS_FIXTURE,
          url: 'wss://broker.example/mqtt',
        });
      }).toThrow(
        'a page chooses no TLS client certificate, its browser does: authenticate it by a password'
      );
    } finally {
      Object.defineProperty(globalThis, 'process', descriptor as PropertyDescriptor);
    }
  });

  test('is secure over mqtts and wss, and over mqtt and ws to the loopback alone', () => {
    const secureOf = (url: string): boolean => {
      return createMqttBrokerAdapter({ id: ID, url }).isSecure;
    };

    expect(
      [
        'mqtts://broker.example:8883',
        'wss://broker.example/mqtt',
        'mqtt://127.0.0.1:1883',
        'ws://localhost:9001/mqtt',
        'mqtt://[::1]:1883',
        'mqtt://broker.example:1883',
        'ws://broker.example/mqtt',
      ].map(secureOf)
    ).toEqual([true, true, true, true, true, false, false]);
    // what is none of its four is refused as it is built, and so is an IPv6 address followed by
    // anything but its port (RFC 3986 §3.2.2), and an id that is none
    for (const refused of [
      { id: ID, url: 'http://broker.example' },
      { id: ID, url: 'no url' },
      { id: ID, url: 'mqtt://[::1]junk:1884' },
      { id: ID, url: 'mqtt://[::1]junk' },
      { id: ID, url: 'ws://[::1]junk/mqtt' },
      { id: ID, url: 'mqtt://user@[::1]junk:1884' },
      { id: '', url: 'mqtt://127.0.0.1' },
    ]) {
      expect(() => {
        return createMqttBrokerAdapter(refused);
      }).toThrow(ProgrammerError);
    }
  });
});

test.describe('createMqttBrokerAdapter, against a broker over MQTT 5', () => {
  // ! one at a time, and beside nothing else of the broker's: a second link of an id takes over,
  // and its groups link the cases' own users, so `test:mqtt` runs on one worker
  test.describe.configure({ mode: 'serial' });

  test('lets one member of a group go at its stop, a name the others serve still taken, and finds no subscriber for its inbox once it stopped, nor for the name once the last did (spec 15.21, 15.26)', async () => {
    test.skip(MQTT_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(MQTT_URL, NO_BROKER).toBeDefined();

    const [leaving, staying, caller] = GROUP_USERS.map((id) => {
      return createMqttBrokerAdapter({ id, password: MQTT_PASSWORD, url: MQTT_URL ?? '' });
    }) as [IMqttBrokerAdapter, IMqttBrokerAdapter, IMqttBrokerAdapter];
    const name = ['bead', 's', `stopping-${String(Date.now())}`];
    const payload = Uint8Array.of(1);
    const heard: number[] = [];

    // ! settled as it is taken, as the core does: MQTT.js's hook holds its packet pump until then
    leaving.on('message', (message) => {
      message.settle();
    });
    staying.on('message', (message) => {
      heard.push(message.payload[0] ?? 0);
      message.settle();
    });

    try {
      await Promise.all([staying.start(), caller.start()]);
      await staying.subscribe(name, { group: 'stopping' });

      // * at once after each stop, as the race the stop closes was
      for (let round = 0; round < 5; round += 1) {
        await leaving.start();
        await leaving.subscribe(['bead', 'i', leaving.id]);
        await leaving.subscribe(name, { group: 'stopping' });
        await leaving.stop();
        expect(
          await caller.publish({ payload, topic: ['bead', 'i', leaving.id] }),
          `its inbox, round ${String(round)}`
        ).toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
        expect(
          await caller.publish({ payload: Uint8Array.of(round), topic: name }),
          `the name, round ${String(round)}`
        ).toBe(BROKER_PUBLISHED.TAKEN);
      }

      // * each taken by the member that stays
      await until(() => {
        return heard.length === 5;
      });
      expect(heard).toEqual([0, 1, 2, 3, 4]);
      await staying.stop();
      expect(await caller.publish({ payload, topic: name })).toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    } finally {
      for (const adapter of [leaving, staying, caller]) {
        await adapter.stop();
      }
    }
  });

  test('a group member’s stop answers each OPEN that comes during it by another member or refuses it 503, none lost (spec 15.21)', async () => {
    test.skip(MQTT_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(MQTT_URL, NO_BROKER).toBeDefined();
    test.setTimeout(30_000);

    const broker = new URL(MQTT_URL ?? '');
    // * the stopping member a round trip of 300 ms away, as the window its stop closes was
    const relay = await createLinkRelay({
      delay: 150,
      host: broker.hostname,
      port: Number(broker.port),
    });
    const [stopping, twin, calling] = GROUP_USERS.map((id, index) => {
      return createBrokerParticipant({
        adapter: createMqttBrokerAdapter({
          id,
          password: MQTT_PASSWORD,
          url: index === 0 ? `mqtt://127.0.0.1:${String(relay.port)}` : (MQTT_URL ?? ''),
        }),
        devtools: false,
      });
    }) as [
      ReturnType<typeof createBrokerParticipant>,
      ReturnType<typeof createBrokerParticipant>,
      ReturnType<typeof createBrokerParticipant>,
    ];
    const name = `stopping-${String(Date.now())}`;
    const outcomes: string[] = [];
    // each connect's outcome: opened by a member, refused 503 by the stopping one, or lost
    const connectOnce = async (): Promise<void> => {
      const client = calling.transportClient();

      try {
        await client.connect({ server: name, timeout: 3_000 });
        outcomes.push('opened');
        await client.disconnect();
      } catch (error) {
        const { message } = error as Error;

        outcomes.push(message.includes('503 busy') ? 'refused 503' : `lost: ${message}`);
      }
    };

    try {
      await stopping.transportServer({ group: true, names: [name] }).start();
      await twin.transportServer({ group: true, names: [name] }).start();
      await calling.start();

      for (let round = 0; round < 2; round += 1) {
        const connects: Promise<void>[] = [];
        const stop = { isSettled: false };
        const stopped = stopping.stop().then(() => {
          stop.isSettled = true;
        });

        // * a connect at once, then every 20 ms through its stop and a round trip past it
        while (!stop.isSettled) {
          connects.push(connectOnce());
          await sleep(20);
        }

        for (let after = 0; after < 15; after += 1) {
          connects.push(connectOnce());
          await sleep(20);
        }

        await stopped;
        await Promise.all(connects);
        await stopping.start();
      }
    } finally {
      for (const participant of [calling, twin, stopping]) {
        await participant[Symbol.asyncDispose]();
      }

      await relay[Symbol.asyncDispose]();
    }

    // * each answered: by another member, or refused 503 by the stopping one, none waiting out its
    // connect
    expect(
      outcomes.filter((outcome) => {
        return outcome.startsWith('lost');
      }),
      'none lost'
    ).toEqual([]);
    expect(outcomes.length, 'each connect made').toBeGreaterThan(20);
  });

  test('carries a link over a WebSocket of subprotocol mqtt (spec 15.25)', async () => {
    test.skip(MQTT_WS_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(MQTT_WS_URL, NO_BROKER).toBeDefined();

    const adapter = createMqttBrokerAdapter({
      id: FIXTURE_USER,
      password: MQTT_PASSWORD,
      url: MQTT_WS_URL ?? '',
    });
    const inbox = ['bead', 'i', FIXTURE_USER];
    const kinds: unknown[] = [];

    // ! settled as it is taken, as the core does: MQTT.js's hook holds its packet pump until then
    adapter.on('message', (message) => {
      const read = readParcel(message.payload);

      kinds.push('parcel' in read ? read.parcel.kind : read);
      message.settle();
    });
    await adapter.start();

    try {
      await adapter.subscribe(inbox);

      const parcel = writeParcel({
        acceptor: Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1),
        kind: ParcelKind.RESET,
        opener: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
        sequence: 0,
      });

      expect(await adapter.publish({ expiresAfter: 5_000, payload: parcel, topic: inbox })).toBe(
        BROKER_PUBLISHED.TAKEN
      );
      await until(() => {
        return kinds.length > 0;
      });
      expect(kinds).toEqual([ParcelKind.RESET]);
      expect(adapter.unsettled).toBe(0);
      // an inbox no one reads is the broker's 0x10
      expect(await adapter.publish({ payload: parcel, topic: ['bead', 'i', 'nobody'] })).toBe(
        BROKER_PUBLISHED.NO_SUBSCRIBER
      );
    } finally {
      await adapter.stop();
    }
  });

  test('sends each WebSocket message to its broker as one binary frame, a burst past 64 KiB among them (spec 15.25)', async () => {
    test.skip(MQTT_WS_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(MQTT_WS_URL, NO_BROKER).toBeDefined();

    await using relay = await createFrameRelay(MQTT_WS_URL ?? '');
    const adapter = createMqttBrokerAdapter({
      id: FIXTURE_USER,
      password: MQTT_PASSWORD,
      url: relay.url,
    });
    const inbox = ['bead', 'i', FIXTURE_USER];
    const heard: Uint8Array[] = [];

    adapter.on('message', (message) => {
      heard.push(message.payload);
      message.settle();
    });
    await adapter.start();

    try {
      await adapter.subscribe(inbox);

      // * each the largest its broker takes, together past 64 KiB, all asked at once
      const size = adapter.maximumPayloadBytes(inbox);
      const payloads = Array.from({ length: Math.ceil(196_608 / size) }, (_, index) => {
        return new Uint8Array(size).fill(index);
      });

      expect(
        await Promise.all(
          payloads.map((payload) => {
            return adapter.publish({ payload, topic: inbox });
          })
        )
      ).toEqual(
        payloads.map(() => {
          return BROKER_PUBLISHED.TAKEN;
        })
      );
      await until(() => {
        return heard.length === payloads.length;
      });
      expect(heard).toEqual(payloads);
      expect(adapter.isLinked).toBe(true);
      // * what its client sent, each message one frame: none ends no message, none continues one
      expect(relay.frames.length).toBeGreaterThan(payloads.length);
      expect(unwholeOf(relay.frames)).toEqual([]);
    } finally {
      await adapter.stop();
    }
  });
});
