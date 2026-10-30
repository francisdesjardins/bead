// dependencies

import { expect, test } from '@playwright/test';
import {
  encodeParcel,
  type IParcel,
  ParcelFlag,
  ParcelKind,
  readParcel,
  writeParcel,
} from '../broker-parcel';
import { createBrokerParticipant } from '../broker-participant';
import { createMemoryBroker } from '../memory-broker';
import { createTestClock } from './fixtures';
import {
  type IParticipantDebugEvent,
  participantHexOf,
  participantParcelOf,
} from '../participant-debug';

// helpers

const settled = (): Promise<void> => {
  return new Promise(setImmediate);
};

const pairOf = async () => {
  const broker = createMemoryBroker();
  const clock = createTestClock();
  const clientAdapter = broker.adapter({ id: 'client' });
  const serverAdapter = broker.adapter({ id: 'server' });
  const clientParticipant = createBrokerParticipant({
    adapter: clientAdapter,
    clock,
    heartbeat: Infinity,
    reconnect: { delay: 0 },
  });
  const serverParticipant = createBrokerParticipant({
    adapter: serverAdapter,
    heartbeat: Infinity,
  });
  const events: IParticipantDebugEvent[] = [];
  const serverEvents: IParticipantDebugEvent[] = [];
  let accept: IParcel | undefined;
  clientAdapter.on('message', ({ payload }) => {
    const read = readParcel(payload);
    if ('parcel' in read && read.parcel.kind === ParcelKind.ACCEPT) {
      accept = read.parcel;
    }
  });
  const hear = (event: IParticipantDebugEvent) => {
    events.push(event);
  };
  clientParticipant.on('debug', hear);
  serverParticipant.on('debug', (event) => {
    serverEvents.push(event);
  });
  const server = serverParticipant.transportServer({ names: ['interop'] });
  const client = clientParticipant.transportClient();
  await server.start();
  await client.connect({ server: 'interop' });
  await settled();
  if (accept === undefined) {
    throw new Error('the ACCEPT reaches the client');
  }
  const send = async (payload: Uint8Array) => {
    await serverAdapter.publish({ payload, topic: ['bead', 'i', 'client'] });
    await settled();
  };
  const stop = async () => {
    await clientParticipant.stop();
    await serverParticipant.stop();
  };
  return {
    accept,
    broker,
    clock,
    hear,
    client,
    clientAdapter,
    clientParticipant,
    events,
    send,
    server,
    serverAdapter,
    serverEvents,
    serverParticipant,
    stop,
  };
};

// definition

// debugging 13.2, 13.4
test('traces each incoming verdict once after judgment and names a loss by its awaited and received sequences', async () => {
  const pair = await pairOf();
  try {
    const { accept, events } = pair;
    events.length = 0;
    const parcel = {
      acceptor: accept.acceptor,
      opener: accept.opener,
      kind: ParcelKind.PONG,
      answers: 2,
      sequence: 3,
    };
    await pair.send(writeParcel(parcel));
    await pair.send(writeParcel(parcel));
    await pair.send(encodeParcel({ ...parcel, kind: 0x80, flags: 0xff, sequence: 4 }));
    await pair.send(writeParcel({ ...parcel, sequence: 6 }));
    expect(
      events
        .filter(({ direction }) => {
          return direction === 'rx';
        })
        .map(({ verdict }) => {
          return verdict;
        })
    ).toEqual(['taken', 'copy', 'advisory', 'loss']);
    expect(
      events.find(({ verdict }) => {
        return verdict === 'advisory';
      })?.flags
    ).toBe(0xff);
    expect(
      events.find(({ verdict }) => {
        return verdict === 'loss';
      })
    ).toMatchObject({ awaited: 5, came: 6, connection: 1, connectionHandle: 'server' });
    expect(
      events.find(({ event }) => {
        return event === 'report';
      })?.report
    ).toContain('a parcel lost: 5 was awaited, and 6 came');
    await pair.send(writeParcel({ ...parcel, sequence: 6 }));
    await pair.send(Uint8Array.of(0));
    await pair.send(encodeParcel({ ...parcel, kind: 0x0a, sequence: 7 }));
    await pair.serverAdapter.publish({
      retained: true,
      payload: writeParcel(parcel),
      topic: ['bead', 'i', 'client'],
    });
    await pair.clientAdapter.subscribe(['other', 'i', 'client']);
    await pair.serverAdapter.publish({
      payload: writeParcel(parcel),
      topic: ['other', 'i', 'client'],
    });
    await settled();
    const received = events.filter(({ direction }) => {
      return direction === 'rx';
    });
    expect(
      received.map(({ verdict }) => {
        return verdict;
      })
    ).toEqual([
      'taken',
      'copy',
      'advisory',
      'loss',
      'pair-not-held',
      'no-parcel',
      'does-not-read',
      'retained',
      'off-topic',
    ]);
    for (const event of received.filter(({ verdict }) => {
      return verdict === 'retained' || verdict === 'off-topic' || verdict === 'no-parcel';
    })) {
      expect(event.layout).toBeUndefined();
      expect(event.opener).toBeUndefined();
    }
  } finally {
    await pair.stop();
  }
});

// debugging 13.3, 13.7
test('traces parcel attempts and third-leg handles without carried bytes, credentials or an acceptor’s half', async () => {
  const pair = await pairOf();
  try {
    await pair.client.send({
      credential: 'trace-secret',
      data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
    });
    await settled();
    const tx = pair.events.find(({ direction, kind }) => {
      return direction === 'tx' && kind === 'DATA';
    });
    expect(tx).toMatchObject({
      carriedBytes: 4,
      connection: 1,
      connectionHandle: 'server',
      hasCredential: true,
      more: false,
    });
    const rx = pair.serverEvents.find(({ direction, kind }) => {
      return direction === 'rx' && kind === 'DATA';
    });
    expect(rx).toMatchObject({
      carriedBytes: 4,
      connection: 1,
      connectionHandle: pair.server.clients[0]?.connectionHandle,
      hasCredential: true,
      verdict: 'taken',
    });
    expect(
      pair.serverEvents.find(({ direction, kind }) => {
        return direction === 'tx' && kind === 'ACCEPT';
      })?.connectionHandle
    ).toBeUndefined();
    expect(
      pair.serverEvents.find(({ direction, kind }) => {
        return direction === 'rx' && kind === 'PING';
      })?.connectionHandle
    ).toBe(pair.server.clients[0]?.connectionHandle);
    const json = JSON.stringify([...pair.events, ...pair.serverEvents]);
    expect(json).not.toContain(participantHexOf(pair.accept.acceptor));
    expect(json).not.toContain('trace-secret');
    expect(json).not.toContain('deadbeef');
    expect(json).not.toContain('acceptor');
    const fields = participantParcelOf({
      ...pair.accept,
      kind: ParcelKind.DATA,
      flags: ParcelFlag.CREDENTIAL | ParcelFlag.MORE,
      carried: new Uint8Array(4),
      credential: 'trace-secret',
    } as IParcel);
    expect(fields).toMatchObject({ carriedBytes: 4, hasCredential: true, more: true });
  } finally {
    await pair.stop();
  }
});

// debugging 13.1, 13.5, 13.8
test('tells completed link transitions and held names by push and keeps levels available by pull', async () => {
  const pair = await pairOf();
  try {
    expect(pair.serverParticipant.names).toEqual(new Set(['interop']));
    expect(pair.serverEvents).toContainEqual({
      event: 'names',
      name: 'interop',
      isHeld: true,
      group: undefined,
    });
    const before = pair.clientParticipant.incarnation;
    pair.clientAdapter.lose();
    await expect
      .poll(() => {
        return pair.events.filter(({ state }) => {
          return state === 'up';
        }).length;
      })
      .toBe(2);
    const links = pair.events.filter(({ event }) => {
      return event === 'link';
    });
    expect(
      links.map(({ state }) => {
        return state;
      })
    ).toEqual(['up', 'down', 'up']);
    expect(links[1]?.ended).toEqual([1]);
    expect(pair.clientParticipant.incarnation).not.toEqual(before);
    expect(pair.clientParticipant.gauges().counts['connections']).toBe(0);
    await pair.client.connect({ server: 'interop' });
    await settled();
    expect(
      pair.events
        .filter(({ kind, direction }) => {
          return kind === 'PING' && direction === 'tx';
        })
        .at(-1)?.connection
    ).toBe(2);
    await pair.clientParticipant.stop();
    await pair.server.stop();
    expect(pair.serverParticipant.names.size).toBe(0);
    expect(
      pair.serverEvents
        .filter(({ event }) => {
          return event === 'names';
        })
        .at(-1)?.isHeld
    ).toBe(false);
    expect(
      pair.events
        .filter(({ event }) => {
          return event === 'link';
        })
        .at(-1)
    ).toMatchObject({ state: 'stopped', ended: [2] });
  } finally {
    await pair.stop();
  }
});

test('tells a takeover once after clearing names and connections and tells no later link transition', async () => {
  const pair = await pairOf();
  try {
    pair.serverParticipant.on('debug', (event) => {
      if (event.state === 'taken-over') {
        expect(pair.serverParticipant.names.size).toBe(0);
        expect(pair.serverParticipant.gauges().counts['connections']).toBe(0);
      }
    });
    pair.serverAdapter.takeOver();
    await settled();
    await pair.serverParticipant.stop();
    expect(
      pair.serverEvents
        .filter(({ event }) => {
          return event === 'link';
        })
        .map(({ state }) => {
          return state;
        })
    ).toEqual(['up', 'taken-over']);
  } finally {
    await pair.stop();
  }
});

// debugging 13.6, 13.9
test('reports a debug listener’s throw and calls later listeners while the participant carries on', async () => {
  const broker = createMemoryBroker();
  const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'client' }) });
  const errors: string[] = [];
  const events: IParticipantDebugEvent[] = [];
  const throwing = () => {
    throw new Error('debug listener');
  };
  participant.on('error', ({ message }) => {
    errors.push(message);
  });
  expect(participant.isDebugging).toBe(false);
  participant.on('debug', throwing);
  participant.on('debug', (event) => {
    events.push(event);
  });
  expect(participant.isDebugging).toBe(true);
  await participant.start();
  expect(participant.isLinked).toBe(true);
  expect(
    events.map(({ event }) => {
      return event;
    })
  ).toEqual(['link']);
  expect(errors).toEqual(['debug listener']);
  participant.off('debug', throwing);
  await participant.stop();
  expect(
    events.map(({ state }) => {
      return state;
    })
  ).toEqual(['up', 'stopped']);
});

// debugging 13.10
test('reads no clock and builds no trace while nobody watches a parcel taken or sent', async () => {
  const pair = await pairOf();
  try {
    pair.clientParticipant.off('debug', pair.hear);
    expect(pair.clientParticipant.isDebugging).toBe(false);
    const before = { ...pair.clock.readings };
    const held = pair.events.length;
    await pair.send(
      writeParcel({ ...pair.accept, kind: ParcelKind.PONG, flags: 0, answers: 2, sequence: 3 })
    );
    await pair.client.send({ data: Uint8Array.of(1) });
    await settled();
    expect(pair.events.length).toBe(held);
    expect(pair.clock.readings).toEqual(before);
    pair.clientParticipant.on('debug', pair.hear);
    await pair.send(
      writeParcel({ ...pair.accept, kind: ParcelKind.PONG, flags: 0, answers: 2, sequence: 4 })
    );
    await pair.client.send({ data: Uint8Array.of(2) });
    await settled();
    expect(
      pair.events.slice(held).map(({ direction }) => {
        return direction;
      })
    ).toEqual(['rx', 'tx']);
  } finally {
    await pair.stop();
  }
});

test('traces malformed held parcels, copies and gaps of a kind to come, and a layout to come before their connection ends', async () => {
  for (const scenario of ['malformed', 'next-kind', 'gap-kind', 'next-layout']) {
    const pair = await pairOf();
    try {
      pair.events.length = 0;
      const fields = {
        acceptor: pair.accept.acceptor,
        opener: pair.accept.opener,
        kind: ParcelKind.PING,
        sequence: 3,
      };
      if (scenario === 'next-kind') {
        await pair.send(encodeParcel({ ...fields, kind: 0x0a, sequence: 1 }));
      }
      const payload = encodeParcel({
        ...fields,
        kind: scenario === 'next-kind' || scenario === 'gap-kind' ? 0x0a : ParcelKind.PING,
        sequence: scenario === 'gap-kind' ? 5 : 3,
        layout: scenario === 'next-layout' ? 0xb2 : 0xb1,
        flags: scenario === 'next-layout' ? 0xff : 0,
      });
      if (scenario === 'malformed') {
        payload[3] = 1;
      }
      await pair.send(payload);
      const rx = pair.events.filter(({ direction }) => {
        return direction === 'rx';
      });
      expect(
        rx.map(({ verdict }) => {
          return verdict;
        })
      ).toEqual(
        scenario === 'next-kind'
          ? ['copy', 'does-not-read']
          : [
              scenario === 'gap-kind'
                ? 'loss'
                : scenario === 'next-layout'
                  ? 'taken'
                  : 'does-not-read',
            ]
      );
      expect(rx.at(-1)?.flags).toBe(scenario === 'next-layout' ? 0xff : 0);
      expect(rx.at(-1)?.connection).toBe(1);
      const close = pair.events.find(({ direction, kind }) => {
        return direction === 'tx' && kind === 'CLOSE';
      });
      expect(close?.code).toBe(scenario === 'gap-kind' ? 4000 : 1002);
      expect(
        pair.events.filter(({ event }) => {
          return event === 'report';
        })
      ).toHaveLength(1);
      expect(pair.client.isOpen()).toBe(false);
    } finally {
      await pair.stop();
    }
  }
});

test('traces held names and departures by their verdict without inventing a connection', async () => {
  const pair = await pairOf();
  try {
    pair.serverEvents.length = 0;
    const publish = async (payload: Uint8Array, place: string) => {
      await pair.clientAdapter.publish({
        payload,
        topic: ['bead', place, place === 's' ? 'interop' : 'client'],
      });
      await settled();
    };
    await publish(Uint8Array.of(0), 's');
    const open = {
      kind: ParcelKind.OPEN,
      opener: pair.accept.opener,
      acceptor: new Uint8Array(8),
      sequence: 1,
      id: 'client',
      incarnation: pair.clientParticipant.incarnation,
      bound: 1024,
    };
    const malformed = encodeParcel(open);
    malformed[3] = 1;
    await publish(malformed, 's');
    await publish(encodeParcel({ ...open, kind: 0x80, flags: 0xff }), 's');
    await publish(encodeParcel({ ...open, layout: 0xb2, flags: 0xff }), 's');
    await publish(Uint8Array.of(0), 'd');
    await publish(
      writeParcel({
        kind: ParcelKind.GONE,
        opener: new Uint8Array(8),
        acceptor: new Uint8Array(8),
        sequence: 0,
        id: 'client',
        incarnation: new Uint8Array(16).fill(1),
      }),
      'd'
    );
    const rx = pair.serverEvents.filter(({ direction }) => {
      return direction === 'rx';
    });
    expect(
      rx.map(({ verdict }) => {
        return verdict;
      })
    ).toEqual(['no-parcel', 'does-not-read', 'advisory', 'taken', 'no-parcel', 'taken']);
    expect(rx[2]?.flags).toBe(0xff);
    expect(rx[3]?.flags).toBe(0xff);
    expect(
      rx.every(({ connection }) => {
        return connection === undefined;
      })
    ).toBe(true);
    expect(
      pair.serverEvents.filter(({ event }) => {
        return event === 'report';
      })
    ).toHaveLength(2);
    expect(
      pair.serverEvents.find(({ kind }) => {
        return kind === 'REFUSE';
      })?.status
    ).toBe(426);
    expect(pair.server.gauges().counts['connections']).toBe(1);
  } finally {
    await pair.stop();
  }
});

test('keeps only each parcel kind’s body fields and the prefix when no body reads', () => {
  const sample: IParcel = {
    layout: 0xb1,
    kind: ParcelKind.OPEN,
    flags: ParcelFlag.SECURE | ParcelFlag.MORE | ParcelFlag.CREDENTIAL,
    opener: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    acceptor: Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1),
    sequence: 3,
    id: 'ada',
    incarnation: new Uint8Array(16).fill(1),
    bound: 1024,
    status: 503,
    carried: Uint8Array.of(1, 2),
    credential: 'trace-secret',
    answers: 2,
    code: 1000,
  };
  const cases: [number, Record<string, unknown>][] = [
    [ParcelKind.OPEN, { id: 'ada', bound: 1024, secure: true, incarnation: '01'.repeat(16) }],
    [ParcelKind.ACCEPT, { id: 'ada', bound: 1024, secure: true, incarnation: '01'.repeat(16) }],
    [ParcelKind.REFUSE, { status: 503 }],
    [ParcelKind.DATA, { carriedBytes: 2, more: true, hasCredential: true }],
    [ParcelKind.PONG, { answers: 2 }],
    [ParcelKind.CLOSE, { code: 1000 }],
    [ParcelKind.GONE, { id: 'ada', incarnation: '01'.repeat(16) }],
    [ParcelKind.PING, {}],
    [ParcelKind.RESET, {}],
    [0x0a, {}],
    [0x80, {}],
  ];
  for (const [kind, body] of cases) {
    const fields = participantParcelOf({ ...sample, kind });
    expect(fields).toEqual({
      flags: 7,
      kind:
        kind === 0x80
          ? 'advisory 128'
          : kind === 0x0a
            ? '0x0A'
            : Object.keys(ParcelKind).find((key) => {
                return ParcelKind[key as keyof typeof ParcelKind] === kind;
              }),
      layout: 0xb1,
      opener: '0102030405060708',
      sequence: 3,
      ...body,
    });
  }
  const { layout, opener, sequence } = sample;
  expect(
    participantParcelOf({
      layout,
      opener,
      sequence,
      acceptor: sample.acceptor,
      kind: ParcelKind.OPEN,
    })
  ).toMatchObject({ id: undefined, incarnation: undefined, secure: undefined });
  expect(
    participantParcelOf({
      layout,
      opener,
      sequence,
      acceptor: sample.acceptor,
      kind: ParcelKind.DATA,
    })
  ).toMatchObject({ carriedBytes: undefined, hasCredential: undefined, more: undefined });
});
