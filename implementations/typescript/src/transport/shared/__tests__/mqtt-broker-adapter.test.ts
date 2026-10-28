// ── MQTT broker adapter ───────────────────────────────────────────────────────

// The adapter over MQTT.js against a scripted MQTT 5 peer, which writes each answer itself and reads
// every packet as it goes; and a link over the WebSocket of the Mosquitto `BEAD_MQTT_URL` names.
// The C# side's `MqttBrokerAdapterTests` play the same sentences.

// dependencies

import { type AddressInfo, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { IPublishPacket, ISubscribePacket, Packet } from 'mqtt-packet';
import { ParcelKind, readParcel, writeParcel } from '../broker-parcel';
import { createBrokerParticipant } from '../broker-participant';
import { BROKER_DELIVERIES, BROKER_PUBLISHED } from '../constants';
import { GenericError, ProgrammerError } from '../errors';
import {
  createMqttBrokerAdapter,
  type IMqttBrokerAdapter,
  type IMqttBrokerAdapterOptions,
  MAXIMUM_PACKET_SIZE,
  TRANSPORT_MQTT,
} from '../mqtt-broker-adapter';
import { LARGEST_PACKET_SIZE, largestPayload } from '../mqtt-packets';
import type { IBrokerDown, IBrokerMessage, IBrokerStart } from '../types';
import { TLS_FIXTURE } from '../../server/__tests__/tls-fixture';
import { createFrameRelay, unwholeOf } from './frame-relay';
import { createMqttScript, type IMqttScript, type IScriptedLink } from './mqtt-script';

// constants

const ID = 'ada';
const INBOX = Object.freeze(['bead', 'i', ID]);
const NAME = Object.freeze(['bead', 's', 'interop']);
const PASSWORD = 'secret';

// the Mosquitto the WebSocket leg plays against, where one is given, and the user it links as,
// which no case and no interop leg is
const MQTT_WS_URL = process.env['BEAD_MQTT_WS_URL'];
const MQTT_PASSWORD = process.env['BEAD_MQTT_PASSWORD'] ?? '';
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)';
const FIXTURE_USER = 'fixture';

// helpers

/** An adapter of `ID` to `script`, its password `PASSWORD` unless told. */
const adapterOf = (
  script: IMqttScript,
  options?: Partial<IMqttBrokerAdapterOptions>
): IMqttBrokerAdapter => {
  return createMqttBrokerAdapter({ id: ID, password: PASSWORD, url: script.url, ...options });
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

/** Polls `isDone` on the real clock until it holds, within five seconds. */
const until = async (isDone: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (!isDone() && Date.now() < deadline) {
    await sleep(5);
  }
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
      password: () => {
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

    await expect(linkUp({ adapter, script }, { properties: { maximumQoS: 0 } })).rejects.toThrow(
      'Maximum QoS 0'
    );
    expect(downs).toEqual([]);

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
    await adapter.stop();
    expect(await pending).toMatchObject({ message: 'the link of ada stopped' });

    const disconnect = await link.next('disconnect');

    expect((disconnect as { reasonCode?: number }).reasonCode ?? 0).toBe(0);
    await link.closed;
    expect(downs).toEqual([]);
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
    await adapter.stop();
  });

  test('lets a subscription go once its UNSUBACK came, naming the topic itself where it held none, and refuses it on a code of 0x80 or more (spec 15.27)', async () => {
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
    await expect(answered(['bead', 'd', 'eve'], 0x87)).rejects.toThrow('0x87');
    await expect(answered(['bead', 'd', 'eve'], 0x80)).rejects.toThrow('0x80');

    // its link kept
    expect(adapter.isLinked).toBe(true);
    await adapter.stop();
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
    await adapter.stop();
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
    await participant.stop();
  });

  test('closes its link, no DISCONNECT, on a packet past its own Maximum Packet Size (spec 15.29)', async () => {
    const adapter = adapterOf(script, { maximumPacketSize: 1_100 });
    const { downs, messages } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    link.send(publishOf({ messageId: 1, payload: new Uint8Array(1_100), topic: 'bead/i/ada' }));
    await link.closed;
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: false }]);
    expect(messages).toEqual([]);
    expect(
      link.packets.filter(({ cmd }) => {
        return cmd === 'disconnect' || cmd === 'puback';
      })
    ).toEqual([]);
  });

  test('announces as its receive bound the largest payload of a message to its inbox within its Maximum Packet Size, a life counted (spec 15.30)', () => {
    expect(adapterOf(script).receiveBound(['bead', 'i', 'server'])).toBe(16_777_188);
    expect(
      adapterOf(script, { maximumPacketSize: 4_096 }).receiveBound(['bead', 'i', 'peer'])
    ).toBe(4_072);
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

    // a stop before its CONNACK ends the start, and one as it asks its password, too
    const stoppedEarly = adapter.start();

    await script.link();
    await adapter.stop();
    await expect(stoppedEarly).rejects.toThrow('before its CONNACK');

    const asking = Promise.withResolvers<string>();
    const asked = adapterOf(script, {
      password: () => {
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
    // what is none of its four is refused as it is built, and so is an id that is none
    for (const refused of [
      { id: ID, url: 'http://broker.example' },
      { id: ID, url: 'no url' },
      { id: '', url: 'mqtt://127.0.0.1' },
    ]) {
      expect(() => {
        return createMqttBrokerAdapter(refused);
      }).toThrow(ProgrammerError);
    }
  });
});

test.describe('createMqttBrokerAdapter, against a broker over MQTT 5', () => {
  // ! one at a time: each links as the fixture's user, and a second link of an id takes over
  test.describe.configure({ mode: 'serial' });

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
