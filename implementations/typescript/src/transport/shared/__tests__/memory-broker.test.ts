// dependencies

import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../errors';
import {
  BROKER_DELIVERIES,
  BROKER_PUBLISHED,
  createMemoryBroker,
  type IMemoryBrokerAdapter,
  MEMORY_BROKER_FAULTS,
  TRANSPORT_BROKER,
} from '../memory-broker';
import type { BrokerTopic } from '../types';
import { createTestClock } from './fixtures';

// constants

const NAME: BrokerTopic = ['bead', 's', 'interop'];
const INBOX: BrokerTopic = ['bead', 'i', 'ada'];

// helpers

/** What `adapter` is handed, as text, each acknowledged as it comes unless `isSettling` is false. */
const heardBy = (
  adapter: IMemoryBrokerAdapter,
  options?: { isSettling?: boolean }
): { retained: boolean; text: string; topic: string }[] => {
  const heard: { retained: boolean; text: string; topic: string }[] = [];

  adapter.on('message', ({ payload, retained, settle, topic }) => {
    heard.push({
      retained: retained === true,
      text: new TextDecoder().decode(payload),
      topic: topic.join('/'),
    });

    if (options?.isSettling !== false) {
      settle();
    }
  });

  return heard;
};

const bytesOf = (text: string): Uint8Array => {
  return new TextEncoder().encode(text);
};

/** Lets every turn the broker queued run. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
};

// definition

test.describe('memory broker', () => {
  test('hands each message on once, in a later turn, in the order its publisher published to that topic (spec 15.24)', async () => {
    const broker = createMemoryBroker();
    const ada = broker.adapter({ id: 'ada' });
    const bob = broker.adapter({ id: 'bob' });

    await ada.start();
    await bob.start();
    await ada.subscribe(INBOX);

    const heard = heardBy(ada, { isSettling: false });
    const payload = bytesOf('one');

    // published in one turn, none awaited before the next
    const published = [payload, bytesOf('two'), bytesOf('three')].map((bytes) => {
      return bob.publish({ payload: bytes, topic: INBOX });
    });

    // * copied as it is published: a publisher that reuses its buffer changes nothing on its way
    payload.fill(0x78);

    expect(heard).toEqual([]);
    await expect(Promise.all(published)).resolves.toEqual([
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
      BROKER_PUBLISHED.TAKEN,
    ]);
    await settled();

    expect(
      heard.map(({ text }) => {
        return text;
      })
    ).toEqual(['one', 'two', 'three']);
    // each handed at least once and not acknowledged yet
    expect(ada.unsettled).toBe(3);
    expect(ada.type).toBe(TRANSPORT_BROKER);
    expect(ada.isSecure).toBe(true);

    // no subscriber takes a publication to a topic nobody holds, and the broker says so
    await expect(bob.publish({ payload: bytesOf('x'), topic: NAME })).resolves.toBe(
      BROKER_PUBLISHED.NO_SUBSCRIBER
    );

    // a message past its life in the broker is deleted before it is handed on
    const clock = createTestClock();
    const timed = createMemoryBroker({ clock });
    const carol = timed.adapter({ id: 'carol' });

    await carol.start();
    await carol.subscribe(INBOX);

    const late = heardBy(carol);

    await carol.publish({ expiresAfter: 0, payload: bytesOf('gone'), topic: INBOX });
    await settled();

    expect(late).toEqual([]);

    // an at-most-once adapter is acknowledged by nothing
    const once = createMemoryBroker({ delivery: BROKER_DELIVERIES.AT_MOST_ONCE });
    const dan = once.adapter({ id: 'dan' });

    await dan.start();
    await dan.subscribe(INBOX);
    heardBy(dan, { isSettling: false });
    await dan.publish({ payload: bytesOf('x'), topic: INBOX });
    await settled();

    expect(dan.delivery).toBe(BROKER_DELIVERIES.AT_MOST_ONCE);
    expect(dan.unsettled).toBe(0);
  });

  test('hands a group message to one member in turn, and again to another when a test asks (spec 15.24)', async () => {
    const broker = createMemoryBroker();
    const [one, two, alone, client] = ['one', 'two', 'alone', 'client'].map((id) => {
      return broker.adapter({ id });
    }) as [IMemoryBrokerAdapter, IMemoryBrokerAdapter, IMemoryBrokerAdapter, IMemoryBrokerAdapter];

    for (const adapter of [one, two, alone, client]) {
      await adapter.start();
    }

    await one.subscribe(NAME, { group: 'interop' });
    await two.subscribe(NAME, { group: 'interop' });
    await alone.subscribe(NAME);

    const heardByOne = heardBy(one);
    const heardByTwo = heardBy(two);
    const heardAlone = heardBy(alone);

    for (const text of ['a', 'b', 'c']) {
      await client.publish({ payload: bytesOf(text), topic: NAME });
    }

    broker.fault(MEMORY_BROKER_FAULTS.REDELIVER, { topic: NAME });
    await client.publish({ payload: bytesOf('d'), topic: NAME });
    await settled();

    const textsOf = (heard: { text: string }[]): string[] => {
      return heard.map(({ text }) => {
        return text;
      });
    };

    // * a member each, in turn, and the last handed again to the next; one alone takes each once
    expect(textsOf(heardByOne)).toEqual(['a', 'c', 'd']);
    expect(textsOf(heardByTwo)).toEqual(['b', 'd']);
    expect(textsOf(heardAlone)).toEqual(['a', 'b', 'c', 'd']);

    // a group needs its adapter to offer one
    const plain = broker.adapter({ capabilities: {}, id: 'plain' });

    await plain.start();
    await expect(plain.subscribe(NAME, { group: 'interop' })).rejects.toThrow(ProgrammerError);
  });

  test('copies, reorders and drops a message as a test asks, drops past a subscriber’s queue bound, and publishes a will as a link is lost (spec 15.24)', async () => {
    const broker = createMemoryBroker({ maximumQueuedMessages: 2 });
    const ada = broker.adapter({ id: 'ada' });
    const bob = broker.adapter({ id: 'bob' });
    const departure: BrokerTopic = ['bead', 'd', 'bob'];

    await ada.start();
    await bob.start({ will: { payload: bytesOf('gone'), topic: departure } });
    await ada.subscribe(INBOX);
    await ada.subscribe(departure);

    const heard = heardBy(ada);
    const texts = (): string[] => {
      return heard.map(({ text }) => {
        return text;
      });
    };

    broker.fault(MEMORY_BROKER_FAULTS.COPY);
    await bob.publish({ payload: bytesOf('copied'), topic: INBOX });
    await settled();
    broker.fault(MEMORY_BROKER_FAULTS.HOLD, { topic: INBOX });
    await bob.publish({ expiresAfter: 60_000, payload: bytesOf('held'), topic: INBOX });
    await bob.publish({ payload: bytesOf('ahead'), topic: INBOX });
    await settled();
    broker.fault(MEMORY_BROKER_FAULTS.DROP);
    await bob.publish({ payload: bytesOf('dropped'), topic: INBOX });
    await settled();

    expect(texts()).toEqual(['copied', 'copied', 'ahead', 'held']);

    // * two held for a subscriber, the third published in the same turn dropped
    await Promise.all(
      ['1', '2', '3'].map((text) => {
        return bob.publish({ payload: bytesOf(text), topic: INBOX });
      })
    );

    await settled();
    expect(texts().slice(4)).toEqual(['1', '2']);

    // a retained message is handed on marked so
    await bob.publish({ payload: bytesOf('kept'), retained: true, topic: INBOX });
    await settled();
    expect(heard.at(-1)).toEqual({ retained: true, text: 'kept', topic: 'bead/i/ada' });

    // a link lost publishes its will, and tells its adapter in a later turn; a stop publishes none
    let downs = 0;

    bob.on('down', () => {
      downs += 1;
    });
    bob.lose();

    expect(bob.isLinked).toBe(false);
    expect(downs).toBe(0);

    await settled();

    expect(downs).toBe(1);
    expect(heard.at(-1)).toEqual({ retained: false, text: 'gone', topic: 'bead/d/bob' });

    await bob.start({ will: { payload: bytesOf('again'), topic: departure } });
    await bob.stop();
    await settled();

    expect(heard.at(-1)?.text).toBe('gone');
    await expect(bob.publish({ payload: bytesOf('x'), topic: INBOX })).rejects.toThrow(
      'the link of bob is not up'
    );
  });

  test('refuses a second adapter of one id, and a will asked of an adapter that takes none', async () => {
    const broker = createMemoryBroker();
    const plain = broker.adapter({ capabilities: {}, id: 'ada' });

    expect(() => {
      return broker.adapter({ id: 'ada' });
    }).toThrow(new ProgrammerError('an adapter of this broker is ada already'));
    await expect(
      plain.start({ will: { payload: bytesOf('gone'), topic: ['bead', 'd', 'ada'] } })
    ).rejects.toThrow(new ProgrammerError('the adapter of ada takes no will'));
    expect(plain.isLinked).toBe(false);
  });

  test('refuses a publication given up on before it goes', async () => {
    const broker = createMemoryBroker();
    const ada = broker.adapter({ id: 'ada' });
    const bob = broker.adapter({ id: 'bob' });

    await ada.start();
    await bob.start();
    await ada.subscribe(INBOX);

    const heard = heardBy(ada);

    await expect(
      bob.publish({ payload: bytesOf('x'), signal: AbortSignal.abort(), topic: INBOX })
    ).rejects.toThrow('the publication was given up on');
    await settled();

    expect(heard).toEqual([]);
  });

  test('refuses a start of a link up already, and a publication past maximumMessageBytes or of a link not up; drops what a link lost held, and a loss of a link not up does nothing', async () => {
    const broker = createMemoryBroker({ maximumMessageBytes: 4 });
    const ada = broker.adapter({ id: 'ada' });
    const bob = broker.adapter({ id: 'bob' });
    let downs = 0;

    ada.on('down', () => {
      downs += 1;
    });

    // a link never up is lost of nothing: no down told
    ada.lose();
    await settled();

    expect(downs).toBe(0);

    await ada.start();
    await bob.start();
    await ada.subscribe(INBOX);

    const heard = heardBy(ada);

    await expect(ada.start()).rejects.toThrow(new ProgrammerError('the link of ada is up already'));
    await expect(bob.publish({ payload: bytesOf('fives'), topic: INBOX })).rejects.toThrow(
      "a payload of 5 bytes, past the broker's maximumMessageBytes, 4 bytes"
    );

    // * published, then its subscriber's link lost in the same turn: what it held goes with it
    const published = bob.publish({ payload: bytesOf('lost'), topic: INBOX });

    ada.lose();
    await settled();

    expect([await published, heard, downs]).toEqual([BROKER_PUBLISHED.TAKEN, [], 1]);
    await expect(ada.publish({ payload: bytesOf('x'), topic: INBOX })).rejects.toThrow(
      'the link of ada is not up'
    );

    // an adapter no listener hears: handed a message, then lost, telling no one
    const cid = broker.adapter({ id: 'cid' });

    await cid.start();
    await cid.subscribe(['bead', 'i', 'cid']);
    await bob.publish({ payload: bytesOf('x'), topic: ['bead', 'i', 'cid'] });
    await settled();
    cid.lose();
    await settled();

    expect(cid.isLinked).toBe(false);
  });

  test('takes a link over as a test asks, as a second link of its id would: its subscriptions dropped, its will published, its down told taken over (spec 15.24)', async () => {
    const broker = createMemoryBroker();
    const ada = broker.adapter({ id: 'ada' });
    const bob = broker.adapter({ id: 'bob' });
    const departure: BrokerTopic = ['bead', 'd', 'bob'];
    const heard = heardBy(ada);
    const downs: { isTakenOver: boolean }[] = [];

    bob.on('down', (down) => {
      downs.push(down);
    });
    await ada.start();
    await ada.subscribe(departure);
    await bob.start({ will: { payload: bytesOf('gone'), topic: departure } });
    await bob.subscribe(['bead', 'i', 'bob']);
    bob.takeOver();

    expect(bob.isLinked).toBe(false);
    expect(downs).toEqual([]);

    await settled();

    expect(downs).toEqual([{ isTakenOver: true }]);
    expect(heard).toEqual([{ retained: false, text: 'gone', topic: 'bead/d/bob' }]);
    // * no link of its id holds its inbox now
    expect(await ada.publish({ payload: bytesOf('x'), topic: ['bead', 'i', 'bob'] })).toBe(
      BROKER_PUBLISHED.NO_SUBSCRIBER
    );

    // a loss tells its down otherwise, and a takeover of a link not up does nothing
    await bob.start();
    bob.lose();
    bob.takeOver();
    await settled();
    expect(downs).toEqual([{ isTakenOver: true }, { isTakenOver: false }]);
  });
});
