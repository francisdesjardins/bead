// ── AMQP broker adapter ───────────────────────────────────────────────────────

// The adapter over rhea against a scripted AMQP 1.0 peer, which reads each session, link, message
// and management request as it goes and answers each itself; and links through the RabbitMQ
// `BEAD_AMQP_URL` names. The C# side's `AmqpBrokerAdapterTests` play the same sentences.

// dependencies

import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import rhea, { type Connection, type Delivery, type Receiver, type Sender } from 'rhea';
import { createBrokerTransportServer } from '../../server/broker-transport-server';
import { createLinkRelay, type ILinkRelay } from '../../server/__tests__/link-relay';
import { TLS_FIXTURE } from '../../server/__tests__/tls-fixture';
import { requestOf } from '../amqp-management';
import {
  createAmqpBrokerAdapter,
  type IAmqpBrokerAdapter,
  type IAmqpBrokerAdapterOptions,
  LINK_CREDIT,
  MAXIMUM_MESSAGE_SIZE,
  TRANSPORT_AMQP,
} from '../amqp-broker-adapter';
import { encodeMessage, largestPayload, LARGEST_UINT } from '../amqp-messages';
import { ParcelKind, writeParcel } from '../broker-parcel';
import { createBrokerParticipant } from '../broker-participant';
import { BROKER_DELIVERIES, BROKER_PUBLISHED } from '../constants';
import { GenericError, ProgrammerError } from '../errors';
import type { BrokerTopic, IBrokerDown, IBrokerMessage } from '../types';
import {
  createAmqpScript,
  type IAmqpScript,
  type IAmqpScriptedLink,
  type IScriptedAttach,
} from './amqp-script';

// constants

const ID = 'ada';
const INBOX = Object.freeze(['bead', 'i', ID]);
const INBOX_QUEUE = '/queues/bead.i.ada';
const NAME = Object.freeze(['bead', 's', 'interop']);
const NAME_QUEUE = '/queues/bead.s.interop';
const PASSWORD = 'secret';

// the body sections rhea writes, which its typings leave untyped
const SECTIONS = rhea.message as unknown as Record<
  'data_section' | 'data_sections' | 'sequence_section',
  (content: unknown) => unknown
>;

// the RabbitMQ the fixture's twins play against, where one is given, and the run's password
const AMQP_URL = process.env['BEAD_AMQP_URL'];
const AMQP_PASSWORD = process.env['BEAD_AMQP_PASSWORD'] ?? '';
const IS_AMQP_REQUIRED = process.env['BEAD_AMQP_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_AMQP_URL is not set (node tools/amqp-broker.mjs start)';
// the user that reads what its broker's queues are, granted nothing a participant is
const FIXTURE_USER = 'fixture';

// helpers

/** An adapter of `ID` to `script`, its password `PASSWORD` unless told. */
const adapterOf = (
  script: IAmqpScript,
  options?: Partial<IAmqpBrokerAdapterOptions>
): IAmqpBrokerAdapter => {
  return createAmqpBrokerAdapter({ id: ID, password: PASSWORD, url: script.url, ...options });
};

/** `adapter` started, its link the script's next. */
const linkUp = async ({
  adapter,
  script,
}: {
  adapter: IAmqpBrokerAdapter;
  script: IAmqpScript;
}): Promise<IAmqpScriptedLink> => {
  const starting = adapter.start();
  const link = await script.link();

  await starting;

  return link;
};

/** `adapter` started and its inbox held, its link the script's next. */
const inboxUp = async (scripted: {
  adapter: IAmqpBrokerAdapter;
  script: IAmqpScript;
}): Promise<IAmqpScriptedLink> => {
  const link = await linkUp(scripted);

  await scripted.adapter.subscribe(INBOX);

  return link;
};

/** The messages and the downs `adapter` tells, as they come. */
const heardOf = (adapter: IAmqpBrokerAdapter) => {
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

/** Polls `isDone` on the real clock until it holds, within `within` milliseconds. */
const until = async (isDone: () => boolean, within = 5_000): Promise<void> => {
  const deadline = Date.now() + within;

  while (!isDone() && Date.now() < deadline) {
    await sleep(5);
  }
};

/** The credit a script's sender holds, as its peer's FLOW last gave it. */
const creditOf = (sender: Sender): number => {
  return (sender as unknown as { credit: number }).credit;
};

/** The script's sender of the adapter's receiver of `address`, its credit come. */
const senderOf = async (link: IAmqpScriptedLink, address: string): Promise<Sender> => {
  const { link: sender } = await link.attachOf(address, { role: 'receiver' });

  await until(() => {
    return (sender as Sender).sendable();
  });

  return sender as Sender;
};

/** A message of one Data section of `payload`, as a broker delivers one. */
const dataOf = (payload: Uint8Array) => {
  return { body: SECTIONS.data_section(Buffer.from(payload)) };
};

/** The outcome a delivery was settled with, as its peer said it: `accepted`, … or none yet. */
const outcomeOf = (delivery: Delivery): string | undefined => {
  return (delivery.remote_state as { constructor?: { composite_type?: string } } | undefined)
    ?.constructor?.composite_type;
};

/** The kinds of the parcels the adapter published to `address`, in their order. */
const kindsTo = (link: IAmqpScriptedLink, address: string): number[] => {
  return link.deliveries
    .filter(({ message }) => {
      return message.to === address;
    })
    .map(({ message }) => {
      return (message.body as { content: Uint8Array }).content[1] ?? 0;
    });
};

/** The links the adapter attached of `role` and `address`. */
const attachesOf = (
  link: IAmqpScriptedLink,
  { address, role }: { address: string | undefined; role: 'receiver' | 'sender' }
): IScriptedAttach[] => {
  return link.attaches.filter((attach) => {
    return attach.address === address && attach.role === role;
  });
};

/** A publication's outcome, or what refused it. */
const settledOf = (pending: Promise<unknown>): Promise<unknown> => {
  return pending.then(
    (value) => {
      return value;
    },
    (error: unknown) => {
      return error instanceof Error ? error : new Error(String(error));
    }
  );
};

// ── against a broker ──

/** A connection of rhea's to the broker at `url` as `user`, its OPEN answered. */
const brokerConnectionOf = async (url: string, user: string): Promise<Connection> => {
  const parsed = new URL(url);
  const container = rhea.create_container({ id: `test-${user}` });

  container.on('error', () => {
    // read where it is held
  });

  const connection = container.connect({
    host: parsed.hostname,
    password: AMQP_PASSWORD,
    port: Number(parsed.port),
    reconnect: false,
    username: user,
  });

  connection.on('disconnected', () => {
    // read where it is held
  });
  await once(connection, 'connection_open');

  return connection;
};

/** Whether the broker at `url` holds the queue `name`, as its management answers the fixture user. */
const holdsQueue = async (url: string, name: string): Promise<boolean> => {
  const connection = await brokerConnectionOf(url, FIXTURE_USER);

  try {
    const { status } = await requestOf(connection, {
      method: 'GET',
      path: `/queues/${encodeURIComponent(name)}`,
    });

    return status === 200;
  } finally {
    connection.close();
  }
};

/** A relay of the test's own in front of the broker at `url`. */
const relayTo = (url: string): Promise<ILinkRelay> => {
  const parsed = new URL(url);

  return createLinkRelay({ host: parsed.hostname, port: Number(parsed.port) });
};

/** The fixture's broker, or the skip that says none is given. */
const brokerUrl = (): string => {
  test.skip(AMQP_URL === undefined && !IS_AMQP_REQUIRED, NO_BROKER);
  expect(AMQP_URL, NO_BROKER).toBeDefined();

  return AMQP_URL ?? '';
};

// definition

test.describe('createAmqpBrokerAdapter', () => {
  test.describe.configure({ timeout: 20_000 });

  let script: IAmqpScript;

  test.beforeEach(async () => {
    script = await createAmqpScript();
  });

  test.afterEach(async () => {
    await script[Symbol.asyncDispose]();
  });

  test('opens a fresh connection each start, its container-id its id, SASL PLAIN as its id or EXTERNAL under a certificate, its idle-time-out its own, and leaves no library to reconnect or recover it (spec 15.33)', async () => {
    let asked = 0;
    const adapter = adapterOf(script, {
      idleTimeout: 1_500,
      password: () => {
        asked += 1;

        return `${PASSWORD}-${String(asked)}`;
      },
    });
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    expect(link.open).toMatchObject({ container_id: ID, idle_time_out: 1_500 });
    expect(link.open['hostname'] ?? null).toBeNull();
    expect(link.plain).toEqual({ password: `${PASSWORD}-1`, username: ID });
    // * not up before its inbox's receiver attached
    expect([adapter.type, adapter.isLinked]).toEqual([TRANSPORT_AMQP, false]);
    // * its inbox's session and its two sending ones, each sender to the anonymous terminus
    expect(link.sessions).toHaveLength(3);
    expect(attachesOf(link, { address: undefined, role: 'sender' })).toHaveLength(2);
    // * one link at a time: a start while it is up is refused
    await expect(adapter.start()).rejects.toThrow('the link of ada is up already');
    await adapter.stop();

    // a password asked at each link's start, renewed with each incarnation, on a fresh connection
    const again = await inboxUp({ adapter, script });

    expect(again.connection).not.toBe(link.connection);
    expect(again.plain).toEqual({ password: `${PASSWORD}-2`, username: ID });

    // * no link comes of its own once one is lost
    again.cut();
    await until(() => {
      return downs.length > 0;
    });
    expect(downs).toEqual([{ isTakenOver: false }]);
    await expect(script.link({ within: 1_500 })).rejects.toThrow('no link came');

    // its virtual host, its OPEN's hostname
    const hosted = adapterOf(script, { virtualHost: 'tenant' });
    const hostedLink = await linkUp({ adapter: hosted, script });

    expect(hostedLink.open['hostname']).toBe('vhost:tenant');
    await hosted.stop();

    // under a client certificate its broker maps to its id, over TLS: SASL EXTERNAL, no password
    const secured = await createAmqpScript({ tls: TLS_FIXTURE });

    try {
      const certified = createAmqpBrokerAdapter({
        id: ID,
        tls: { ca: TLS_FIXTURE.cert, cert: TLS_FIXTURE.cert, key: TLS_FIXTURE.key },
        url: secured.url,
      });
      const bare = await linkUp({ adapter: certified, script: secured });

      expect(bare.open).toMatchObject({ container_id: ID });
      expect(bare.plain).toBeUndefined();
      expect(certified.isSecure).toBe(true);
      await certified.stop();
    } finally {
      await secured[Symbol.asyncDispose]();
    }

    // a certificate in the clear is refused as it is built
    expect(() => {
      return createAmqpBrokerAdapter({ id: ID, tls: TLS_FIXTURE, url: script.url });
    }).toThrow('a TLS client certificate is carried over amqps');
  });

  test('refuses its inbox when either management link is refused and closes its connection without telling a loss', async () => {
    for (const refused of ['sender', 'receiver'] as const) {
      const adapter = adapterOf(script);
      const { downs } = heardOf(adapter);
      const link = await linkUp({ adapter, script });

      script.policy.attach = ({ address, role }) => {
        return address === '/management' && role === refused
          ? { refuse: { condition: 'amqp:not-allowed', description: 'management denied' } }
          : 'take';
      };

      try {
        await expect(adapter.subscribe(INBOX)).rejects.toThrow(
          'amqp:not-allowed, management denied'
        );
        await link.closed;
        expect([adapter.isLinked, downs]).toEqual([false, []]);
        expect(
          link.requests.map(({ method }) => {
            return method;
          })
        ).not.toContain('PUT');
      } finally {
        await adapter.stop();
      }
    }
  });

  test('fails its queued publications and pending name subscription when stopped and lets none reach its next link', async () => {
    script.policy.credit = 1;

    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    expect(await adapter.publish({ payload: Uint8Array.of(1), topic: INBOX })).toBe(
      BROKER_PUBLISHED.TAKEN
    );
    const waiting = settledOf(adapter.publish({ payload: Uint8Array.of(2), topic: INBOX }));

    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const begun = link.sessions.length;
    const subscribing = settledOf(adapter.subscribe(NAME));

    await link.until(() => {
      return link.deliveries.length === 1 && link.sessions.length === begun + 1;
    });
    expect(link.deliveries).toHaveLength(1);
    await adapter.stop();

    for (const pending of [waiting, subscribing]) {
      expect(await pending).toBeInstanceOf(Error);
      expect(((await pending) as Error).message).toBe('the link of ada stopped');
    }

    await link.closed;
    expect([downs, adapter.isLinked, adapter.unsettled]).toEqual([[], false, 0]);
    expect(link.deliveries).toHaveLength(1);
    script.policy.attach = () => {
      return 'take';
    };
    script.policy.settle = () => {
      return 'accepted';
    };

    const next = await inboxUp({ adapter, script });

    expect(await adapter.publish({ payload: Uint8Array.of(3), topic: INBOX })).toBe(
      BROKER_PUBLISHED.TAKEN
    );
    expect(
      next.deliveries.map(({ message }) => {
        return [...(message.body as { content: Uint8Array }).content];
      })
    ).toEqual([[3]]);
    expect([downs, adapter.isLinked]).toEqual([[], true]);
    await adapter.stop();
  });

  test('fails a transmitted publication without an outcome, a queued publication and a pending name subscription alike when stopped, none NoSubscriber', async () => {
    script.policy.credit = 1;
    script.policy.settle = () => {
      return 'hold';
    };

    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const sent = settledOf(adapter.publish({ payload: Uint8Array.of(1), topic: INBOX }));
    const waiting = settledOf(adapter.publish({ payload: Uint8Array.of(2), topic: INBOX }));

    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const begun = link.sessions.length;
    const subscribing = settledOf(adapter.subscribe(NAME));

    await link.until(() => {
      return link.deliveries.length === 1 && link.sessions.length === begun + 1;
    });
    await adapter.stop();

    // * what an ending session held is never its broker's released
    for (const pending of [sent, waiting, subscribing]) {
      expect(await pending).toBeInstanceOf(Error);
      expect(((await pending) as Error).message).toBe('the link of ada stopped');
    }

    await link.closed;
    expect([downs, adapter.isLinked, adapter.unsettled]).toEqual([[], false, 0]);
    expect(link.deliveries).toHaveLength(1);
  });

  test('refuses its start when a sending link is refused, and a publication whose fresh sending link is refused, sending nothing on it and keeping its link (spec 15.33)', async () => {
    const refusing = (): void => {
      script.policy.attach = ({ address, role }) => {
        return address === undefined && role === 'sender'
          ? { refuse: { condition: 'amqp:not-allowed', description: 'sender denied' } }
          : 'take';
      };
    };

    refusing();

    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const starting = settledOf(adapter.start());
    const first = await script.link();

    expect(String(await starting)).toContain('amqp:not-allowed, sender denied');
    await first.closed;
    expect([downs, adapter.isLinked]).toEqual([[], false]);
    script.policy.attach = () => {
      return 'take';
    };

    // * the inboxes' sending session ended: the next publication begins another, refused
    const link = await inboxUp({ adapter, script });

    expect(await adapter.publish({ payload: Uint8Array.of(1), topic: INBOX })).toBe(
      BROKER_PUBLISHED.TAKEN
    );

    const ended = link.deliveries[0]?.receiver.session;

    ended?.close();
    await link.until(() => {
      return ended?.is_closed() === true;
    });
    refusing();
    expect(
      String(await settledOf(adapter.publish({ payload: Uint8Array.of(2), topic: INBOX })))
    ).toContain('amqp:not-allowed, sender denied');
    expect([link.deliveries.length, downs, adapter.isLinked]).toEqual([1, [], true]);
    script.policy.attach = () => {
      return 'take';
    };
    expect(await adapter.publish({ payload: Uint8Array.of(3), topic: INBOX })).toBe(
      BROKER_PUBLISHED.TAKEN
    );
    expect(link.deliveries).toHaveLength(2);
    await adapter.stop();
  });

  test('refuses a publication and a subscription whose signal is aborted without sending either or losing its link', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const begun = link.sessions.length;
    const declared = link.requests.length;

    try {
      for (const topic of [INBOX, NAME]) {
        await expect(
          adapter.publish({ payload: Uint8Array.of(1), signal: AbortSignal.abort(), topic })
        ).rejects.toThrow();
        await expect(adapter.subscribe(topic, { signal: AbortSignal.abort() })).rejects.toThrow();
      }

      expect([link.deliveries, link.sessions.length, link.requests.length]).toEqual([
        [],
        begun,
        declared,
      ]);
      expect([downs, adapter.isLinked]).toEqual([[], true]);
      expect(await adapter.publish({ payload: Uint8Array.of(2), topic: INBOX })).toBe(
        BROKER_PUBLISHED.TAKEN
      );
    } finally {
      await adapter.stop();
    }
  });

  test('fails a start whose sending links remain unanswered within connectTimeout and starts a fresh link afterwards', async () => {
    script.policy.attach = ({ address }) => {
      return address === undefined ? 'hold' : 'take';
    };

    const adapter = adapterOf(script, { connectTimeout: 1_000 });
    const { downs } = heardOf(adapter);
    const starting = settledOf(adapter.start());
    const link = await script.link();

    await link.until(() => {
      return link.sessions.length === 3;
    });
    expect(String(await starting)).toContain('within 1000 ms');
    await link.closed;
    expect([downs, adapter.isLinked]).toEqual([[], false]);
    script.policy.attach = () => {
      return 'take';
    };

    const next = await inboxUp({ adapter, script });

    expect(next.connection).not.toBe(link.connection);
    expect(adapter.isLinked).toBe(true);
    await adapter.stop();
  });

  test('fails an inbox declaration left unanswered within connectTimeout and closes its connection without telling a loss', async () => {
    const adapter = adapterOf(script, { connectTimeout: 1_000 });
    const { downs } = heardOf(adapter);
    const link = await linkUp({ adapter, script });

    script.policy.answer = () => {
      return 'hold';
    };

    const subscribing = settledOf(adapter.subscribe(INBOX));

    await link.until(() => {
      return link.requests.length === 1;
    });
    expect(String(await subscribing)).toContain('within 1000 ms');
    await link.closed;
    expect(
      link.requests.map(({ method }) => {
        return method;
      })
    ).toEqual(['PUT']);
    expect([downs, adapter.isLinked, adapter.unsettled]).toEqual([[], false, 0]);
    await adapter.stop();
  });

  test('declares its inbox exclusive, classic and not durable through management on its own connection, binds it to its root’s exchange, and is up once its receiver attached (spec 15.33)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    let isHeld = false;

    script.policy.attach = ({ address }) => {
      return address === INBOX_QUEUE ? 'hold' : 'take';
    };

    const subscribing = adapter.subscribe(INBOX).then(() => {
      isHeld = true;
    });

    await link.attachOf(INBOX_QUEUE, { role: 'receiver' }).catch(() => {
      return undefined;
    });
    await link.until(() => {
      return link.requests.length === 2;
    });
    expect(
      link.requests.map(({ body, method, path }) => {
        return { body, method, path };
      })
    ).toEqual([
      {
        body: {
          arguments: { 'x-queue-type': 'classic' },
          auto_delete: false,
          durable: false,
          exclusive: true,
        },
        method: 'PUT',
        path: '/queues/bead.i.ada',
      },
      {
        body: {
          arguments: {},
          binding_key: 'bead.i.ada',
          destination_queue: 'bead.i.ada',
          source: 'bead',
        },
        method: 'POST',
        path: '/bindings',
      },
    ]);

    // * held once its receiver's ATTACH named its source, not before
    await sleep(100);
    expect(isHeld).toBe(false);
    link.releaseAttaches();
    await subscribing;
    expect(attachesOf(link, { address: INBOX_QUEUE, role: 'receiver' })).toHaveLength(1);
    expect(adapter.isLinked).toBe(true);
    await adapter.stop();
  });

  test('fails its start on a declaration answered other than 200 or 201, naming it, and while another connection of its id holds the inbox, its participant linking once it is let go (spec 15.33)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);

    script.policy.answer = (request) => {
      if (request.method === 'PUT') {
        request.answer(400, { body: 'cannot obtain exclusive access to locked queue' });

        return 'hold';
      }

      return 204;
    };

    const link = await linkUp({ adapter, script });

    await expect(adapter.subscribe(INBOX)).rejects.toThrow(
      'its broker answered the declaration of bead.i.ada 400: cannot obtain exclusive access to locked queue'
    );
    // * its connection closed, its inbox ending with it, and no loss told: it was never up
    await link.closed;
    expect([adapter.isLinked, downs]).toEqual([false, []]);

    // its participant's start fails with it, and links once the inbox is let go
    const participant = createBrokerParticipant({ adapter, heartbeat: Infinity });

    await expect(participant.start()).rejects.toThrow('400');
    script.policy.answer = (request) => {
      return request.method === 'PUT' ? 200 : 204;
    };
    await participant.start();
    expect(participant.isLinked).toBe(true);
    await participant.stop();

    // * and on its binding answered other than 204, naming it
    script.policy.answer = (request) => {
      return request.method === 'PUT' ? 201 : 403;
    };

    const bound = await linkUp({ adapter, script });

    await expect(adapter.subscribe(INBOX)).rejects.toThrow(
      'its broker answered the binding of bead.i.ada 403'
    );
    await bound.closed;
    expect([adapter.isLinked, downs]).toEqual([false, []]);
  });

  test('fails its start and closes its connection when its management’s link is detached, its session ended or its connection lost between its inbox’s declaration and its binding, and leaves no queue of its id behind (spec 15.33)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const between = (
      act: (link: IAmqpScriptedLink, binding: IScriptedAttach | undefined) => void
    ) => {
      return async (): Promise<string> => {
        script.policy.answer = (request) => {
          return request.method === 'PUT' ? 201 : 'hold';
        };

        const link = await linkUp({ adapter, script });
        const subscribing = settledOf(adapter.subscribe(INBOX));

        await link.until(() => {
          return link.requests.some(({ method }) => {
            return method === 'POST';
          });
        });
        act(link, link.attaches.at(-1));

        const settled = await subscribing;

        await link.closed;

        return String(settled);
      };
    };

    expect(
      await between((_link, binding) => {
        binding?.link.close({ condition: 'amqp:internal-error' });
      })()
    ).toContain("the management's receiver ended as it asked POST /bindings: amqp:internal-error");
    expect(
      await between((_link, binding) => {
        binding?.session.close({ condition: 'amqp:internal-error' });
      })()
    ).toContain("the management's session ended as it asked POST /bindings: amqp:internal-error");
    expect(
      await between((link) => {
        link.cut();
      })()
    ).toContain('the link of ada went down');
    // * each time its connection closed, no loss told, since it was never up, and no attempt of its
    // own after
    expect(downs).toEqual([]);
    expect(adapter.isLinked).toBe(false);
  });

  test('tells its link lost once on the end of its connection, or of its inbox’s session or receiver, closes its connection, and lets nothing of a lost link reach the next (spec 15.33)', async () => {
    const adapter = adapterOf(script);
    const { downs, messages } = heardOf(adapter);

    // its connection cut
    const first = await inboxUp({ adapter, script });
    const inboxSender = await senderOf(first, INBOX_QUEUE);

    inboxSender.send(dataOf(Uint8Array.of(1)));
    await until(() => {
      return messages.length > 0;
    });
    script.policy.settle = () => {
      return 'hold';
    };

    const pending = settledOf(adapter.publish({ payload: Uint8Array.of(1), topic: INBOX }));

    await first.until(() => {
      return first.deliveries.length > 0;
    });
    first.cut();
    expect(await pending).toBeInstanceOf(GenericError);
    await until(() => {
      return downs.length > 0;
    });

    // * its inbox's receiver detached, its connection closed
    const second = await inboxUp({ adapter, script });

    // ! a message of the former link settled now reaches nothing of the next
    messages[0]?.settle();
    expect(adapter.unsettled).toBe(0);
    (await second.attachOf(INBOX_QUEUE, { role: 'receiver' })).link.close({
      condition: 'amqp:resource-deleted',
    });
    await second.closed;
    await until(() => {
      return downs.length > 1;
    });

    // * its inbox's session ended, its connection closed
    const third = await inboxUp({ adapter, script });

    (await third.attachOf(INBOX_QUEUE, { role: 'receiver' })).session.close({
      condition: 'amqp:internal-error',
    });
    await third.closed;
    await until(() => {
      return downs.length > 2;
    });
    expect(downs).toEqual([{ isTakenOver: false }, { isTakenOver: false }, { isTakenOver: false }]);
    // * what is asked of a link that is down is refused at once
    await expect(adapter.publish({ payload: Uint8Array.of(1), topic: INBOX })).rejects.toThrow(
      'the link of ada is not up'
    );
    await expect(adapter.subscribe(NAME)).rejects.toThrow('the link of ada is not up');
    await expect(adapter.unsubscribe(NAME)).rejects.toThrow('the link of ada is not up');

    // a listener let go hears no loss after, nor a message
    const later: IBrokerDown[] = [];
    const heard: IBrokerMessage[] = [];
    const listener = (down: IBrokerDown): void => {
      later.push(down);
    };
    const hearing = (message: IBrokerMessage): void => {
      heard.push(message);
    };
    const fourth = await inboxUp({ adapter, script });

    adapter.on('down', listener);
    adapter.off('down', listener);
    adapter.on('message', hearing);
    adapter.off('message', hearing);
    (await senderOf(fourth, INBOX_QUEUE)).send(dataOf(Uint8Array.of(4)));
    await until(() => {
      return messages.length > 1;
    });
    fourth.cut();
    await until(() => {
      return downs.length > 3;
    });
    expect([downs.length, later, heard]).toEqual([4, [], []]);
  });

  test('attaches a held name’s receiver again once, on a fresh session, when its broker ends it, telling no loss, and tells its link lost when that is refused or the name is lost again, never attaching a name it lets go (spec 15.33)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);

    const [held] = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' });

    // * ended by its broker: attached again, on a session of its own, and no loss told
    held?.link.close({ condition: 'amqp:resource-deleted' });
    await link.until(() => {
      return attachesOf(link, { address: NAME_QUEUE, role: 'receiver' }).length === 2;
    });

    const [, again] = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' });

    expect(again?.session).not.toBe(held?.session);
    await sleep(100);
    expect([downs, adapter.isLinked]).toEqual([[], true]);

    // lost again on the same link: its link lost
    again?.session.close({ condition: 'amqp:unauthorized-access' });
    await link.closed;
    await until(() => {
      return downs.length > 0;
    });

    // * attached again and refused: its link lost
    const next = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);
    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? { refuse: { condition: 'amqp:not-found' } } : 'take';
    };
    attachesOf(next, { address: NAME_QUEUE, role: 'receiver' })[0]?.link.close({
      condition: 'amqp:resource-deleted',
    });
    await next.closed;
    await until(() => {
      return downs.length > 1;
    });
    expect(attachesOf(next, { address: NAME_QUEUE, role: 'receiver' })).toHaveLength(2);

    // * a name let go is never attached again
    script.policy.attach = () => {
      return 'take';
    };

    const last = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);
    await adapter.unsubscribe(NAME);
    await sleep(100);
    expect(attachesOf(last, { address: NAME_QUEUE, role: 'receiver' })).toHaveLength(1);
    expect([downs.length, adapter.isLinked]).toEqual([2, true]);

    // * let go while its receiver is attached again: let go at once, and that ATTACH never held
    await adapter.subscribe(NAME);
    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const begun = last.sessions.length;

    attachesOf(last, { address: NAME_QUEUE, role: 'receiver' })
      .at(-1)
      ?.link.close({ condition: 'amqp:resource-deleted' });
    await last.until(() => {
      return last.sessions.length === begun + 1;
    });
    await adapter.unsubscribe(NAME);
    await last.until(() => {
      return last.ended.includes(last.sessions.at(-1) as never);
    });
    last.releaseAttaches();
    await sleep(100);
    expect([downs.length, adapter.isLinked]).toEqual([2, true]);
    await adapter.stop();
  });

  test('refuses each publication a sending session held as it ends, keeps its link, and begins another for the next (spec 15.33)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });

    script.policy.settle = () => {
      return 'hold';
    };

    const publishing = [1, 2].map((index) => {
      return settledOf(adapter.publish({ payload: Uint8Array.of(index), topic: INBOX }));
    });

    await link.until(() => {
      return link.deliveries.length === 2;
    });

    const sessions = link.sessions.length;

    link.deliveries[0]?.receiver.session.close({
      condition: 'amqp:unauthorized-access',
      description: 'write access to topic bead.i.ada denied',
    });

    for (const settled of await Promise.all(publishing)) {
      expect(String(settled)).toContain(
        'the broker of ada ended the session that sends to inboxes: amqp:unauthorized-access'
      );
    }

    expect([adapter.isLinked, downs]).toEqual([true, []]);

    // * the next publication on a session and a sender of its own
    script.policy.settle = () => {
      return 'accepted';
    };
    expect(await adapter.publish({ payload: Uint8Array.of(3), topic: INBOX })).toBe(
      BROKER_PUBLISHED.TAKEN
    );
    expect(link.sessions).toHaveLength(sessions + 1);
    expect(link.deliveries[2]?.receiver.session).not.toBe(link.deliveries[0]?.receiver.session);

    // and one to a name, on its own sending session, which the inboxes' end left alone
    expect(await adapter.publish({ payload: Uint8Array.of(4), topic: NAME })).toBe(
      BROKER_PUBLISHED.TAKEN
    );
    expect(link.deliveries[3]?.receiver.session).not.toBe(link.deliveries[2]?.receiver.session);
    await adapter.stop();
  });

  test('subscribes a name on a session of its own, unsettled, first, no max-message-size, held once its ATTACH named its source (spec 15.34)', async () => {
    const adapter = adapterOf(script);
    const link = await inboxUp({ adapter, script });
    let isHeld = false;

    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const subscribing = adapter.subscribe(NAME, { group: 'interop' }).then(() => {
      isHeld = true;
    });

    await link.until(() => {
      return link.sessions.length === 6;
    });
    await sleep(100);
    expect(isHeld).toBe(false);
    link.releaseAttaches();
    await subscribing;

    // * a name held, subscribed again, is held at once, no second ATTACH
    await adapter.subscribe(NAME);
    expect(attachesOf(link, { address: NAME_QUEUE, role: 'receiver' })).toHaveLength(1);

    const [name] = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' });
    const [inbox] = attachesOf(link, { address: INBOX_QUEUE, role: 'receiver' });

    // * its group the name's queue itself, on a session no other link holds
    expect(name?.session).not.toBe(inbox?.session);
    expect(name?.attach).toMatchObject({ rcv_settle_mode: 0, snd_settle_mode: 0 });
    expect(name?.attach['max_message_size'] ?? null).toBeNull();
    expect(inbox?.attach['max_message_size'] ?? null).toBeNull();
    await adapter.stop();

    // * its stop: each receiver detached, then its CLOSE of no error
    expect(link.detached).toEqual(expect.arrayContaining([name, inbox]));
    expect(link.closeFrame?.error ?? null).toBeNull();
    expect(link.closeFrame).toBeDefined();

    // at most once, settled
    const quick = adapterOf(script, { delivery: BROKER_DELIVERIES.AT_MOST_ONCE });
    const quickLink = await linkUp({ adapter: quick, script });

    script.policy.attach = () => {
      return 'take';
    };
    await quick.subscribe(NAME);
    expect(
      attachesOf(quickLink, { address: NAME_QUEUE, role: 'receiver' })[0]?.attach
    ).toMatchObject({ snd_settle_mode: 1 });
    await quick.stop();
  });

  test('refuses a name whose ATTACH names no source and is detached, whose session its broker ends, or past its broker’s channel-max, naming it, and keeps every other (spec 15.34)', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);
    script.policy.attach = ({ address }) => {
      if (address === '/queues/bead.s.absent') {
        return { refuse: { condition: 'amqp:not-found', description: 'no queue bead.s.absent' } };
      }

      if (address === '/queues/bead.s.denied') {
        return { endSession: { condition: 'amqp:unauthorized-access' } };
      }

      return 'take';
    };
    await expect(adapter.subscribe(['bead', 's', 'absent'])).rejects.toThrow(
      'the broker of ada refused the subscription to bead.s.absent: amqp:not-found, no queue bead.s.absent'
    );
    await expect(adapter.subscribe(['bead', 's', 'denied'])).rejects.toThrow(
      'the broker of ada refused the subscription to bead.s.denied: amqp:unauthorized-access'
    );
    await sleep(100);
    expect(link.detached).toEqual(
      attachesOf(link, { address: '/queues/bead.s.absent', role: 'receiver' })
    );
    expect([downs, adapter.isLinked]).toEqual([[], true]);
    await adapter.stop();

    // * past its broker's channel-max: four sessions beside its names, so two names under 5
    const narrow = await createAmqpScript({ channelMax: 5 });

    try {
      const bounded = adapterOf(narrow);
      const boundedLink = await inboxUp({ adapter: bounded, script: narrow });

      await bounded.subscribe(['bead', 's', 'one']);
      await bounded.subscribe(['bead', 's', 'two']);

      const begun = boundedLink.sessions.length;

      await expect(bounded.subscribe(['bead', 's', 'three'])).rejects.toThrow(
        'the broker of ada gives 6 sessions a connection, its channel-max 5, so no session for bead.s.three'
      );
      // * refused before a session began for it
      await sleep(50);
      expect(boundedLink.sessions).toHaveLength(begun);
      expect(bounded.isLinked).toBe(true);
      await bounded.stop();
    } finally {
      await narrow[Symbol.asyncDispose]();
    }
  });

  test('grants its inbox’s receiver linkCredit as it attaches and one more as each message is settled, never as it arrives (spec 15.34)', async () => {
    const adapter = adapterOf(script, { linkCredit: 3 });
    const { messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const sender = await senderOf(link, INBOX_QUEUE);

    await until(() => {
      return creditOf(sender) === 3;
    });
    expect(creditOf(sender)).toBe(3);

    for (const index of [1, 2, 3]) {
      sender.send(dataOf(Uint8Array.of(index)));
    }

    await until(() => {
      return messages.length === 3;
    });
    await sleep(100);
    // * none restored as they arrive
    expect([creditOf(sender), adapter.unsettled]).toEqual([0, 3]);
    messages[0]?.settle();
    await until(() => {
      return creditOf(sender) === 1;
    });
    expect([creditOf(sender), adapter.unsettled]).toEqual([1, 2]);
    messages[1]?.settle();
    messages[2]?.settle();
    await until(() => {
      return creditOf(sender) === 3;
    });
    expect([creditOf(sender), adapter.unsettled]).toEqual([3, 0]);
    await adapter.stop();
  });

  test('grants a name’s receiver a credit of 1, so that of the OPENs its broker holds for a member with room for one it hands on one, the others left in the name’s queue, none refused (spec 15.34)', async () => {
    const adapter = adapterOf(script);
    const participant = createBrokerParticipant({ adapter, heartbeat: Infinity });
    const server = createBrokerTransportServer(participant, {
      group: true,
      maximumConnections: 1,
      names: ['interop'],
    });
    const starting = server.start();
    const link = await script.link();

    await starting;

    const inbox = await senderOf(link, INBOX_QUEUE);
    const name = await senderOf(link, NAME_QUEUE);

    expect([creditOf(inbox), creditOf(name)]).toEqual([LINK_CREDIT, 1]);

    // * three OPENs waiting in the name's queue, its broker handing on as many as its credit lets
    const waiting = [1, 2, 3].map((index) => {
      return dataOf(
        writeParcel({
          acceptor: new Uint8Array(8),
          bound: 65_536,
          id: 'peer',
          incarnation: new Uint8Array(16),
          kind: ParcelKind.OPEN,
          opener: Uint8Array.of(0xa0 + index, 0, 0, 0, 0, 0, 0, index),
          sequence: 1,
        })
      );
    });
    const handed: Delivery[] = [];
    const offer = (): void => {
      while (waiting.length > 0 && name.sendable()) {
        handed.push(name.send(waiting.shift() as never));
      }
    };

    name.on('sendable', offer);
    offer();

    // the first taken, which fills the server: the name let go, every other left in its queue,
    // unsent or detached unsettled
    await link.until(() => {
      return link.detached.some(({ address, role }) => {
        return address === NAME_QUEUE && role === 'receiver';
      });
    });
    await sleep(100);
    expect(kindsTo(link, '/exchanges/bead/bead.i.peer')).toEqual([ParcelKind.ACCEPT]);
    expect(outcomeOf(handed[0] as Delivery)).toBe('accepted');
    expect(
      handed.filter((delivery) => {
        return outcomeOf(delivery) === undefined;
      }).length + waiting.length
    ).toBe(2);
    await server.stop();
    await participant.stop();
  });

  test('lets a name go once its DETACH came, and its inbox once management deleted it, telling no loss (spec 15.34)', async () => {
    const adapter = adapterOf(script);
    const { downs, messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);

    const [name] = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' });
    const sender = await senderOf(link, NAME_QUEUE);

    sender.send(dataOf(Uint8Array.of(1)));
    await until(() => {
      return messages.length === 1;
    });

    // ! its DETACH waits for what it handed on to be settled, and none is credited once let go
    let isLetGo = false;
    const unsubscribing = adapter.unsubscribe(NAME).then(() => {
      isLetGo = true;
    });

    await sleep(100);
    expect([link.detached.includes(name as never), isLetGo]).toEqual([false, false]);
    messages[0]?.settle();
    await unsubscribing;
    // * its DETACH, then its session ended
    expect([link.detached.includes(name as never), creditOf(sender)]).toEqual([true, 0]);
    await link.until(() => {
      return link.ended.includes(name?.session as never);
    });

    // * subscribed again and let go holding nothing, its DETACH at once: what its broker hands on
    // before it answered that DETACH is not handed on, and the name is let go once it did
    script.policy.detach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'answer';
    };
    await adapter.subscribe(NAME);

    const again = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' })[1] as IScriptedAttach;
    const againSender = again.link as Sender;

    await until(() => {
      return againSender.sendable();
    });

    let isLetGoAgain = false;
    const unsubscribingAgain = adapter.unsubscribe(NAME).then(() => {
      isLetGoAgain = true;
    });

    await link.until(() => {
      return link.detached.includes(again);
    });
    againSender.send(dataOf(Uint8Array.of(2)));
    await sleep(100);
    expect([isLetGoAgain, messages.length]).toEqual([false, 1]);
    link.releaseDetaches();
    await unsubscribingAgain;
    script.policy.detach = () => {
      return 'answer';
    };

    // its inbox deleted by its broker's management, its receiver's DETACH no loss
    script.policy.answer = () => {
      return 'hold';
    };

    let isGone = false;
    const leaving = adapter.unsubscribe(INBOX).then(() => {
      isGone = true;
    });

    await link.until(() => {
      return link.requests.some(({ method }) => {
        return method === 'DELETE';
      });
    });

    const request = link.requests.find(({ method }) => {
      return method === 'DELETE';
    });

    expect(request?.path).toBe('/queues/bead.i.ada');
    (await link.attachOf(INBOX_QUEUE, { role: 'receiver' })).link.close({
      condition: 'amqp:resource-deleted',
    });
    await sleep(100);
    expect(isGone).toBe(false);
    request?.answer(200);
    await leaving;
    await sleep(100);
    expect([downs, adapter.isLinked]).toEqual([[], true]);

    // a name it does not hold let go at once
    await adapter.unsubscribe(['bead', 's', 'other']);
    await adapter.stop();

    // * an inbox whose deletion is answered other than 200 is refused, naming it, and still held:
    // its end then its link lost
    script.policy.answer = (asked) => {
      return asked.method === 'DELETE' ? 500 : asked.method === 'PUT' ? 201 : 204;
    };

    const kept = await inboxUp({ adapter, script });

    await expect(adapter.unsubscribe(INBOX)).rejects.toThrow(
      'its broker answered the deletion of bead.i.ada 500'
    );
    (await kept.attachOf(INBOX_QUEUE, { role: 'receiver' })).link.close({
      condition: 'amqp:resource-deleted',
    });
    await until(() => {
      return downs.length > 0;
    });
    expect([downs, adapter.isLinked]).toEqual([[{ isTakenOver: false }], false]);
  });

  test('lets a name go within one connectTimeout, what it handed on settled and its DETACH answered, and tells its link lost past it (spec 15.34, 15.37)', async () => {
    const adapter = adapterOf(script, { connectTimeout: 300 });
    const { downs, messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const lostWithin =
      'the link of ada was lost: it let the name bead.s.interop go within no 300 ms, its connectTimeout';

    await adapter.subscribe(NAME);

    // * what it handed on not settled within it: no DETACH goes, and its link is lost
    const sender = await senderOf(link, NAME_QUEUE);
    const delivery = sender.send(dataOf(Uint8Array.of(1)));

    await until(() => {
      return messages.length === 1;
    });
    await expect(adapter.unsubscribe(NAME)).rejects.toThrow(lostWithin);
    await link.closed;
    expect([downs, adapter.isLinked, adapter.unsettled]).toEqual([
      [{ isTakenOver: false }],
      false,
      0,
    ]);
    expect(attachesOf(link, { address: NAME_QUEUE, role: 'receiver' })[0]).toBeDefined();
    expect(
      link.detached.map(({ address }) => {
        return address;
      })
    ).not.toContain(NAME_QUEUE);
    messages[0]?.settle();
    expect(outcomeOf(delivery)).toBeUndefined();

    // * its DETACH not answered within it: its link lost the same
    script.policy.detach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'answer';
    };

    const unanswered = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);
    await expect(adapter.unsubscribe(NAME)).rejects.toThrow(lostWithin);
    expect(
      unanswered.detached.map(({ address }) => {
        return address;
      })
    ).toContain(NAME_QUEUE);
    await unanswered.closed;
    expect([downs.length, adapter.isLinked]).toEqual([2, false]);

    // * its link lost as it lets a name go: its let-go fails, naming that loss
    script.policy.detach = () => {
      return 'answer';
    };

    const cut = await inboxUp({ adapter, script });

    await adapter.subscribe(NAME);
    (await senderOf(cut, NAME_QUEUE)).send(dataOf(Uint8Array.of(2)));
    await until(() => {
      return messages.length === 2;
    });

    const cutting = settledOf(adapter.unsubscribe(NAME));

    cut.cut();
    expect(String(await cutting)).toContain('the link of ada went down');
    expect([downs.length, adapter.isLinked]).toEqual([3, false]);
  });

  test('waits, subscribing a name under way, for its ATTACH to name its source, and lets a name whose subscription an unsubscription met go once it attached, never held (spec 15.34)', async () => {
    const adapter = adapterOf(script);
    const { downs, messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const held: string[] = [];

    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    // * subscribed twice under way: one session and its ATTACH, and neither held before its broker
    // answered it
    const begun = link.sessions.length;
    const subscribing = [1, 2].map((index) => {
      return adapter.subscribe(NAME).then(() => {
        held.push(`subscribed ${String(index)}`);
      });
    });

    await link.until(() => {
      return link.sessions.length === begun + 1;
    });
    await sleep(100);
    expect([held, link.sessions.length]).toEqual([[], begun + 1]);
    link.releaseAttaches();
    await Promise.all(subscribing);
    expect([held, attachesOf(link, { address: NAME_QUEUE, role: 'receiver' })]).toEqual([
      ['subscribed 1', 'subscribed 2'],
      [expect.anything()],
    ]);
    await adapter.unsubscribe(NAME);

    // * an unsubscription meets one under way: it is let go once attached, and never held, what its
    // broker hands on before it answered its DETACH not handed on
    script.policy.detach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'answer';
    };

    const subscribed = adapter.subscribe(NAME);

    await link.until(() => {
      return link.sessions.length === begun + 2;
    });

    const unsubscribing = adapter.unsubscribe(NAME).then(() => {
      held.push('let go');
    });

    await sleep(100);
    expect(held).toHaveLength(2);
    link.releaseAttaches();

    const met = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' })[1] as IScriptedAttach;
    const metSender = met.link as Sender;

    await until(() => {
      return metSender.sendable();
    });
    metSender.send(dataOf(Uint8Array.of(1)));
    await link.until(() => {
      return link.detached.includes(met);
    });
    await sleep(100);
    expect([held, messages]).toEqual([['subscribed 1', 'subscribed 2'], []]);
    link.releaseDetaches();
    await Promise.all([subscribed, unsubscribing]);
    expect([held.at(-1), messages]).toEqual(['let go', []]);
    script.policy.detach = () => {
      return 'answer';
    };

    // * one asked once an unsubscription met the one under way subscribes anew, once that is let go
    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const before = link.sessions.length;
    const letGoFirst = adapter.subscribe(NAME);

    await link.until(() => {
      return link.sessions.length === before + 1;
    });

    const leaving = adapter.unsubscribe(NAME);
    const anew = adapter.subscribe(NAME);

    link.releaseAttaches();
    await Promise.all([letGoFirst, leaving]);
    await link.until(() => {
      return link.sessions.length === before + 2;
    });
    link.releaseAttaches();
    await anew;
    expect(attachesOf(link, { address: NAME_QUEUE, role: 'receiver' }).at(-1)?.session).toBe(
      link.sessions.at(-1)
    );
    await adapter.unsubscribe(NAME);

    // a subscription refused: one that met it fails with it, an unsubscription that met it holds
    // nothing to let go, and one asked after that subscribes anew, refused in its turn
    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? { refuse: { condition: 'amqp:not-found' } } : 'take';
    };

    const refusedAt = link.sessions.length;
    const refused = [adapter.subscribe(NAME), adapter.subscribe(NAME)];
    const letGo = adapter.unsubscribe(NAME);
    const refusedAnew = adapter.subscribe(NAME);

    for (const outcome of await Promise.all([...refused, refusedAnew].map(settledOf))) {
      expect(String(outcome)).toContain('amqp:not-found');
    }

    await letGo;
    expect(link.sessions).toHaveLength(refusedAt + 2);

    // * one given up, which another met: that other subscribes anew, and is held
    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const given = new AbortController();
    const begunGivenUp = link.sessions.length;
    const first = settledOf(adapter.subscribe(NAME, { signal: given.signal }));
    const second = adapter.subscribe(NAME);

    await link.until(() => {
      return link.sessions.length === begunGivenUp + 1;
    });
    given.abort();
    expect(await first).toBeInstanceOf(Error);
    await link.until(() => {
      return link.sessions.length === begunGivenUp + 2;
    });
    link.releaseAttaches();
    await second;
    expect(attachesOf(link, { address: NAME_QUEUE, role: 'receiver' }).at(-1)?.session).toBe(
      link.sessions.at(-1)
    );
    expect([downs, adapter.isLinked]).toEqual([[], true]);
    await adapter.stop();
  });

  test('hands on and credits what comes to its inbox while its deletion is under way, and keeps its inbox where its deletion is refused or not answered within connectTimeout (spec 15.34, 15.37)', async () => {
    const adapter = adapterOf(script, { connectTimeout: 300, linkCredit: 2 });
    const { downs, messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const sender = await senderOf(link, INBOX_QUEUE);
    const deletions: { answer: (status: number) => void }[] = [];

    script.policy.answer = (request) => {
      if (request.method === 'DELETE') {
        deletions.push(request);

        return 'hold';
      }

      return request.method === 'PUT' ? 201 : 204;
    };

    // * a parcel during its deletion: handed on, and its credit given back as it is settled
    const deleting = settledOf(adapter.unsubscribe(INBOX));

    await link.until(() => {
      return deletions.length === 1;
    });
    sender.send(dataOf(Uint8Array.of(1)));
    await until(() => {
      return messages.length === 1;
    });
    messages[0]?.settle();
    await until(() => {
      return creditOf(sender) === 2;
    });
    expect(creditOf(sender)).toBe(2);

    // its deletion refused: its inbox still held, handing on and crediting
    deletions[0]?.answer(500);
    expect(String(await deleting)).toContain('its broker answered the deletion of bead.i.ada 500');
    sender.send(dataOf(Uint8Array.of(2)));
    await until(() => {
      return messages.length === 2;
    });
    expect([downs, adapter.isLinked]).toEqual([[], true]);

    // * its deletion not answered within connectTimeout: refused, naming it, its inbox still held
    await expect(adapter.unsubscribe(INBOX)).rejects.toThrow(
      'the broker of ada answered the deletion of bead.i.ada within no 300 ms, its connectTimeout'
    );
    sender.send(dataOf(Uint8Array.of(3)));
    await until(() => {
      return messages.length === 3;
    });
    expect([downs, adapter.isLinked]).toEqual([[], true]);

    // its end then its link lost
    (await link.attachOf(INBOX_QUEUE, { role: 'receiver' })).link.close({
      condition: 'amqp:resource-deleted',
    });
    await until(() => {
      return downs.length > 0;
    });
    expect([downs, adapter.isLinked]).toEqual([[{ isTakenOver: false }], false]);
  });

  test('publishes each parcel as one message of format 0 to the anonymous terminus, unsettled, its to the topic’s exchange address, a life its header’s ttl in milliseconds rounded up where one is asked, and nothing else (spec 15.35)', async () => {
    const adapter = adapterOf(script);
    const link = await linkUp({ adapter, script });
    const payload = Uint8Array.of(1, 2, 3);

    for (const expiresAfter of [undefined, 0.5, 1_000, 1_000.2, 60_000]) {
      expect(
        await adapter.publish({
          payload,
          topic: INBOX,
          ...(expiresAfter === undefined ? {} : { expiresAfter }),
        })
      ).toBe(BROKER_PUBLISHED.TAKEN);

      const delivered = link.deliveries.at(-1);

      expect(Buffer.from(delivered?.bytes ?? []).toString('hex')).toBe(
        Buffer.from(
          encodeMessage(
            '/exchanges/bead/bead.i.ada',
            payload,
            expiresAfter === undefined ? undefined : { ttl: Math.max(1, Math.ceil(expiresAfter)) }
          )
        ).toString('hex')
      );
      expect([delivered?.delivery.format, delivered?.delivery.remote_settled]).toEqual([0, false]);
    }

    // * each sender of no address: the anonymous terminus, unsettled
    for (const sender of attachesOf(link, { address: undefined, role: 'sender' })) {
      expect(sender.attach).toMatchObject({ snd_settle_mode: 0 });
      expect(
        (sender.attach['target'] as { address?: unknown } | undefined)?.address ?? null
      ).toBeNull();
    }

    // and a name's through its own sender, to its exchange address
    expect(await adapter.publish({ payload, topic: NAME })).toBe(BROKER_PUBLISHED.TAKEN);
    expect(link.deliveries.at(-1)?.message.to).toBe('/exchanges/bead/bead.s.interop');
    expect(link.deliveries.at(-1)?.receiver).not.toBe(link.deliveries[0]?.receiver);
    await adapter.stop();

    // at most once, each settled as it goes, with no outcome to read
    const quick = adapterOf(script, { delivery: BROKER_DELIVERIES.AT_MOST_ONCE });
    const quickLink = await linkUp({ adapter: quick, script });

    expect([quick.delivery, quick.capabilities.noSubscriber]).toEqual([
      BROKER_DELIVERIES.AT_MOST_ONCE,
      false,
    ]);
    expect(await quick.publish({ payload, topic: INBOX })).toBe(BROKER_PUBLISHED.TAKEN);
    await quickLink.until(() => {
      return quickLink.deliveries.length > 0;
    });
    expect(quickLink.deliveries[0]?.delivery.remote_settled).toBe(true);
    await quick.stop();
  });

  test('holds its publications to its sender’s credit, the next going as credit comes, in their order, and delays no receiver for them (spec 15.35)', async () => {
    script.policy.credit = 2;

    const adapter = adapterOf(script);
    const link = await inboxUp({ adapter, script });
    const publishing = [1, 2, 3, 4, 5].map((index) => {
      return adapter.publish({ payload: Uint8Array.of(index), topic: INBOX });
    });

    await sleep(100);
    expect(link.deliveries).toHaveLength(2);

    // * a name subscribed past them, its credit none of theirs
    await adapter.subscribe(NAME);
    expect(link.deliveries).toHaveLength(2);

    const receiver = link.deliveries[0]?.receiver as Receiver;

    for (const expected of [3, 4, 5]) {
      receiver.add_credit(1);
      await link.until(() => {
        return link.deliveries.length === expected;
      });
    }

    expect(await Promise.all(publishing)).toEqual(
      publishing.map(() => {
        return BROKER_PUBLISHED.TAKEN;
      })
    );
    expect(
      link.deliveries.map(({ message }) => {
        return [...(message.body as { content: Buffer }).content];
      })
    ).toEqual([[1], [2], [3], [4], [5]]);
    await adapter.stop();
  });

  test('reads accepted as taken, released as no subscriber, and rejected or any other outcome as refused (spec 15.35)', async () => {
    const adapter = adapterOf(script);
    const link = await inboxUp({ adapter, script });
    const answered = async (
      outcome: 'accepted' | 'modified' | 'rejected' | 'released'
    ): Promise<unknown> => {
      script.policy.settle = () => {
        return outcome;
      };

      return settledOf(adapter.publish({ payload: Uint8Array.of(1), topic: NAME }));
    };

    expect(await answered('accepted')).toBe(BROKER_PUBLISHED.TAKEN);
    expect(await answered('released')).toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    expect(String(await answered('rejected'))).toContain(
      'the broker of ada refused a publication, rejected: amqp:precondition-failed, scripted'
    );
    expect(String(await answered('modified'))).toContain(
      'the broker of ada refused a publication, modified'
    );
    expect([adapter.capabilities.noSubscriber, adapter.isLinked]).toEqual([true, true]);
    expect(link.deliveries).toHaveLength(4);
    await adapter.stop();
  });

  test('refuses a publication past its sender’s max-message-size before it goes (spec 15.35)', async () => {
    script.policy.maximumMessageSize = 1_024;

    const adapter = adapterOf(script);

    // * before any link, what a uint holds
    expect(adapter.maximumPayloadBytes(INBOX)).toBe(
      largestPayload('/exchanges/bead/bead.i.ada', LARGEST_UINT)
    );

    const link = await linkUp({ adapter, script });
    const room = adapter.maximumPayloadBytes(INBOX);

    // its bound counts a life, whatever the publication
    expect(room).toBe(largestPayload('/exchanges/bead/bead.i.ada', 1_024));
    expect(
      await adapter.publish({ expiresAfter: 1_000, payload: new Uint8Array(room), topic: INBOX })
    ).toBe(BROKER_PUBLISHED.TAKEN);
    await expect(
      adapter.publish({ expiresAfter: 1_000, payload: new Uint8Array(room + 1), topic: INBOX })
    ).rejects.toThrow(
      "a message of 1025 bytes to /exchanges/bead/bead.i.ada, past its sender's max-message-size, 1024 bytes"
    );
    await sleep(50);
    expect(link.deliveries).toHaveLength(1);

    // * the last link's bound while it is down
    link.cut();
    await until(() => {
      return !adapter.isLinked;
    });
    expect(adapter.maximumPayloadBytes(INBOX)).toBe(room);
  });

  test('hands each message on before its accepted, which goes once it is settled, on the receiver it came on, and once, never released or modified (spec 15.36)', async () => {
    const adapter = adapterOf(script);
    const { messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const sender = await senderOf(link, INBOX_QUEUE);
    const delivery = sender.send(dataOf(Uint8Array.of(9)));

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
    expect(outcomeOf(delivery)).toBeUndefined();

    messages[0]?.settle();
    messages[0]?.settle();
    await until(() => {
      return outcomeOf(delivery) !== undefined;
    });
    expect([outcomeOf(delivery), delivery.remote_settled, adapter.unsettled]).toEqual([
      'accepted',
      true,
      0,
    ]);
    expect(messages).toHaveLength(1);

    // * a name's message, on its own receiver, settled there
    await adapter.subscribe(NAME);

    const named = await senderOf(link, NAME_QUEUE);
    const opened = named.send(dataOf(Uint8Array.of(7)));

    await until(() => {
      return messages.length > 1;
    });
    expect(messages[1]?.topic).toEqual(['bead', 's', 'interop']);
    messages[1]?.settle();
    await until(() => {
      return outcomeOf(opened) !== undefined;
    });
    expect(outcomeOf(opened)).toBe('accepted');

    // ! a name's message settled once its receiver was attached again is settled on neither, and
    // counted no more
    const [held] = attachesOf(link, { address: NAME_QUEUE, role: 'receiver' });
    const lost = named.send(dataOf(Uint8Array.of(8)));

    await until(() => {
      return messages.length > 2;
    });
    held?.link.close({ condition: 'amqp:internal-error' });
    await link.until(() => {
      return attachesOf(link, { address: NAME_QUEUE, role: 'receiver' }).length === 2;
    });
    expect(adapter.unsettled).toBe(0);
    messages[2]?.settle();
    await sleep(100);
    expect(outcomeOf(lost)).toBeUndefined();
    await adapter.stop();

    // * at most once: a message its broker settled is handed on, no accepted to go, and one more
    // credit granted as it is settled
    const quick = adapterOf(script, { delivery: BROKER_DELIVERIES.AT_MOST_ONCE, linkCredit: 1 });
    const { messages: quickly } = heardOf(quick);
    const quickLink = await inboxUp({ adapter: quick, script });
    const quickSender = await senderOf(quickLink, INBOX_QUEUE);
    const presettled = quickSender.send(dataOf(Uint8Array.of(9)));

    (presettled as unknown as { settled: boolean }).settled = true;
    await until(() => {
      return quickly.length === 1;
    });
    expect([quick.unsettled, creditOf(quickSender)]).toEqual([0, 0]);
    quickly[0]?.settle();
    await until(() => {
      return creditOf(quickSender) === 1;
    });
    expect(outcomeOf(presettled)).toBeUndefined();
    await quick.stop();
  });

  test('hands on a message whose body is other than one Data section, or whose payload passes its receive bound, as no parcel, its link kept (spec 15.36)', async () => {
    const adapter = adapterOf(script, { maximumMessageSize: 2_048 });
    const { downs, messages } = heardOf(adapter);
    const link = await inboxUp({ adapter, script });
    const sender = await senderOf(link, INBOX_QUEUE);
    const bound = adapter.receiveBound(INBOX);

    expect(bound).toBe(largestPayload('/exchanges/bead/bead.i.ada', 2_048));

    for (const message of [
      { body: 'a value' },
      { body: SECTIONS.data_sections([Buffer.of(1), Buffer.of(2)]) },
      { body: SECTIONS.sequence_section([1, 2]) },
      { body: { content: Buffer.of(1), typecode: 0x75 } },
      dataOf(new Uint8Array(bound + 1)),
      dataOf(new Uint8Array(bound)),
    ]) {
      sender.send(message);
    }

    await until(() => {
      return messages.length === 6;
    });
    expect(
      messages.map(({ payload }) => {
        return payload.length;
      })
    ).toEqual([0, 0, 0, 0, 0, bound]);

    for (const message of messages) {
      message.settle();
    }

    await sleep(50);
    expect([downs, adapter.isLinked, adapter.unsettled]).toEqual([[], true, 0]);
    await adapter.stop();
  });

  test('announces as its receive bound the largest payload of a message to its inbox within its maximumMessageSize, and refuses as it is built a maximumMessageSize outside 1 to 4,294,967,295 and a linkCredit outside 1 to 2,147,483,647 (spec 15.37)', () => {
    const bounded = adapterOf(script, { maximumMessageSize: 4_096 });

    expect([
      adapterOf(script).receiveBound(['bead', 'i', 'server']),
      bounded.receiveBound(['bead', 'i', 'peer']),
      bounded.receiveBound(['bead', 'i', 'server']),
    ]).toEqual([16_777_156, 4_038, 4_036]);
    expect(MAXIMUM_MESSAGE_SIZE).toBe(16_777_216);

    // * a bound no message of the topic fits within takes no payload; what it publishes, before any
    // sender's ATTACH named a bound, is held within 4,294,967,295 bytes
    expect(adapterOf(script, { maximumMessageSize: 1 }).receiveBound(INBOX)).toBe(0);
    expect(adapterOf(script).maximumPayloadBytes(NAME)).toBe(
      largestPayload('/exchanges/bead/bead.s.interop', LARGEST_UINT)
    );

    // * a bound whose receive bound is under 1,024 is refused as its participant is built, and one
    // out of its range, or what is no whole number, as the adapter is
    expect(() => {
      return createBrokerParticipant({ adapter: adapterOf(script, { maximumMessageSize: 1_000 }) });
    }).toThrow("a participant's inbox takes a parcel of 1,024 bytes at least");

    for (const maximumMessageSize of [0, -1, 1.5, LARGEST_UINT + 1, Infinity, Number.NaN]) {
      expect(() => {
        return adapterOf(script, { maximumMessageSize });
      }).toThrow(ProgrammerError);
    }

    for (const linkCredit of [0, -1, 1.5, 2_147_483_648]) {
      expect(() => {
        return adapterOf(script, { linkCredit });
      }).toThrow(ProgrammerError);
    }

    expect([
      adapterOf(script, { maximumMessageSize: LARGEST_UINT }).receiveBound(INBOX),
      adapterOf(script, { linkCredit: 2_147_483_647 }).receiveBound(INBOX),
    ]).toEqual([largestPayload('/exchanges/bead/bead.i.ada', LARGEST_UINT), 16_777_159]);
  });

  test('gives up a start, a subscription or a publication its signal aborts: a start’s connection closed, a name’s session ended, a publication that waits on credit left unsent', async () => {
    const adapter = adapterOf(script);
    const { downs } = heardOf(adapter);

    // * a start, its senders' ATTACHes held: its connection closed
    script.policy.attach = ({ address, role }) => {
      return address === undefined && role === 'sender' ? 'hold' : 'take';
    };

    const given = new AbortController();
    const starting = adapter.start({ signal: given.signal });
    const held = await script.link();

    await held.until(() => {
      return held.sessions.length === 3;
    });
    given.abort();
    await expect(starting).rejects.toThrow();
    await held.closed;
    expect(downs).toEqual([]);
    await expect(adapter.start({ signal: AbortSignal.abort() })).rejects.toThrow();

    // a stop as it asks its password ends that start
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

    // * a name's subscription, its ATTACH held: its session ended, its link kept
    script.policy.attach = ({ address }) => {
      return address === NAME_QUEUE ? 'hold' : 'take';
    };

    const link = await inboxUp({ adapter, script });
    const begun = link.sessions.length;
    const cancelled = new AbortController();
    const subscribing = adapter.subscribe(NAME, { signal: cancelled.signal });

    await link.until(() => {
      return link.sessions.length === begun + 1;
    });

    const nameSession = link.sessions[begun];

    cancelled.abort();
    await expect(subscribing).rejects.toThrow();
    await link.until(() => {
      return link.ended.includes(nameSession as never);
    });
    expect([downs, adapter.isLinked]).toEqual([[], true]);

    await adapter.stop();

    // * a publication waiting on credit: left unsent, its link kept
    script.policy.attach = () => {
      return 'take';
    };
    script.policy.credit = 1;
    script.policy.settle = () => {
      return 'hold';
    };

    const credited = await inboxUp({ adapter, script });
    const first = settledOf(adapter.publish({ payload: Uint8Array.of(1), topic: INBOX }));
    const leaving = new AbortController();
    const waiting = adapter.publish({
      payload: Uint8Array.of(2),
      signal: leaving.signal,
      topic: INBOX,
    });

    await credited.until(() => {
      return credited.deliveries.length === 1;
    });
    leaving.abort();
    await expect(waiting).rejects.toThrow();

    const [{ delivery: sent, receiver } = credited.deliveries[0] as never] = credited.deliveries;

    receiver.add_credit(10);
    await sleep(100);
    expect(credited.deliveries).toHaveLength(1);
    sent.accept();
    expect(await first).toBe(BROKER_PUBLISHED.TAKEN);

    // * a publication given up once it went is forgotten, its link kept
    const abandoned = new AbortController();
    const publishing = adapter.publish({
      payload: Uint8Array.of(3),
      signal: abandoned.signal,
      topic: INBOX,
    });

    await credited.until(() => {
      return credited.deliveries.length === 2;
    });
    abandoned.abort();
    await expect(publishing).rejects.toThrow();
    credited.deliveries[1]?.delivery.accept();
    await sleep(50);
    expect([downs, adapter.isLinked]).toEqual([[], true]);
    await adapter.stop();

    // * its inbox's subscription given up as it is declared: its link retired, its queue with it
    script.policy.answer = () => {
      return 'hold';
    };

    const declaring = await linkUp({ adapter, script });
    const inboxCancelled = new AbortController();
    const inboxSubscribing = adapter.subscribe(INBOX, { signal: inboxCancelled.signal });

    await declaring.until(() => {
      return declaring.requests.length === 1;
    });
    inboxCancelled.abort();
    await expect(inboxSubscribing).rejects.toThrow();
    // * its connection closed, and no loss told: it was never up
    await declaring.closed;
    expect([downs, adapter.isLinked]).toEqual([[], false]);
  });

  test('refuses a departure, offering no will (spec 15.32)', async () => {
    const adapter = adapterOf(script);

    expect(adapter.capabilities).toEqual({
      expiry: true,
      groups: true,
      noSubscriber: true,
      will: false,
    });

    const link = await linkUp({ adapter, script });

    await expect(adapter.subscribe(['bead', 'd', 'bob'])).rejects.toThrow(
      'the adapter of ada offers no will, so no departure to subscribe'
    );
    expect(link.sessions).toHaveLength(3);
    await adapter.stop();
  });

  test('is secure over amqps, and over amqp to the loopback alone', () => {
    const secureOf = (url: string): boolean => {
      return createAmqpBrokerAdapter({ id: ID, url }).isSecure;
    };

    expect(
      [
        'amqps://broker.example:5671',
        'amqp://127.0.0.1:5672',
        'amqp://localhost',
        'amqp://[::1]:5672',
        'amqp://broker.example:5672',
      ].map(secureOf)
    ).toEqual([true, true, true, true, false]);

    // what is none of its two is refused as it is built, and so is an id that is none
    for (const refused of [
      { id: ID, url: 'mqtt://broker.example' },
      { id: ID, url: 'no url' },
      { id: '', url: 'amqp://127.0.0.1' },
    ]) {
      expect(() => {
        return createAmqpBrokerAdapter(refused);
      }).toThrow(ProgrammerError);
    }
  });

  test('refuses a WebSocket URL and a page, naming why', () => {
    for (const url of ['ws://broker.example/amqp', 'wss://broker.example/amqp']) {
      expect(() => {
        return createAmqpBrokerAdapter({ id: ID, url });
      }).toThrow('RabbitMQ 4 carries AMQP 1.0 over no WebSocket');
    }

    // * a page: no Node beneath it
    const { process: node } = globalThis;

    Object.defineProperty(globalThis, 'process', { configurable: true, value: undefined });

    try {
      expect(() => {
        return createAmqpBrokerAdapter({ id: ID, url: 'amqp://127.0.0.1' });
      }).toThrow('an AMQP 1.0 adapter runs in Node alone');
    } finally {
      Object.defineProperty(globalThis, 'process', { configurable: true, value: node });
    }
  });
});

test.describe('createAmqpBrokerAdapter, against a broker over AMQP 1.0', () => {
  // ! one at a time, and beside nothing else of the broker's: each twin links the users the cases
  // link, two links of one id refuse each other, and the cases empty the name's queue, so
  // `test:amqp` runs on one worker
  test.describe.configure({ mode: 'serial', retries: 0, timeout: 30_000 });

  test('fails its start on a declaration answered other than 200 or 201, naming it, and while another connection of its id holds the inbox, its participant linking once it is let go (spec 15.33)', async () => {
    // ! three of the fixture's heartbeat of 10 s and its close: about 40 s
    test.setTimeout(120_000);

    const url = brokerUrl();
    const id = 'late';
    const relay = await relayTo(url);
    const holder = createAmqpBrokerAdapter({
      id,
      idleTimeout: 1_000,
      password: AMQP_PASSWORD,
      url: `amqp://127.0.0.1:${String(relay.port)}`,
    });
    const refusals: string[] = [];
    const counting = Object.assign(Object.create(holder) as IAmqpBrokerAdapter, {
      subscribe: (topic: BrokerTopic, options?: Parameters<IAmqpBrokerAdapter['subscribe']>[1]) => {
        return holder.subscribe(topic, options).catch((reason: unknown) => {
          refusals.push(String(reason));

          throw reason;
        });
      },
    });
    const participant = createBrokerParticipant({
      adapter: counting,
      heartbeat: Infinity,
      reconnect: { delay: 1_000 },
    });

    try {
      await participant.start();

      // * another connection of its id refused its inbox while the first holds it
      const second = createAmqpBrokerAdapter({ id, password: AMQP_PASSWORD, url });

      await second.start();
      await expect(second.subscribe(['bead', 'i', id])).rejects.toThrow(
        'its broker answered the declaration of bead.i.late 400'
      );
      expect(second.isLinked).toBe(false);

      // * the holder silent: its next link refused until its broker reaps the first, then linked
      const former = participant.incarnation;

      relay.silence();
      await until(() => {
        return participant.isLinked && participant.incarnation !== former;
      }, 100_000);
      expect(participant.isLinked).toBe(true);
      expect(refusals.length).toBeGreaterThan(0);
      expect(refusals[0]).toContain('400');
    } finally {
      await participant.stop();
      await relay[Symbol.asyncDispose]();
    }
  });

  test('fails its start and closes its connection when its management’s link is detached, its session ended or its connection lost between its inbox’s declaration and its binding, and leaves no queue of its id behind (spec 15.33)', async () => {
    const url = brokerUrl();
    const id = 'coming';
    const relay = await relayTo(url);
    const adapter = createAmqpBrokerAdapter({
      id,
      password: AMQP_PASSWORD,
      url: `amqp://127.0.0.1:${String(relay.port)}`,
    });

    try {
      await adapter.start();

      const subscribing = settledOf(adapter.subscribe(['bead', 'i', id]));

      // * its connection lost once its queue is declared
      for (let tries = 0; tries < 200 && !(await holdsQueue(url, `bead.i.${id}`)); tries += 1) {
        await sleep(5);
      }

      relay.cut();
      await subscribing;

      // its queue gone with its connection
      for (let tries = 0; tries < 100 && (await holdsQueue(url, `bead.i.${id}`)); tries += 1) {
        await sleep(50);
      }

      expect(await holdsQueue(url, `bead.i.${id}`)).toBe(false);
      expect(adapter.isLinked).toBe(false);
    } finally {
      await adapter.stop();
      await relay[Symbol.asyncDispose]();
    }
  });

  test('refuses each publication a sending session held as it ends, keeps its link, and begins another for the next (spec 15.33)', async () => {
    const url = brokerUrl();
    const adapter = createAmqpBrokerAdapter({ id: 'flagged', password: AMQP_PASSWORD, url });

    await adapter.start();

    try {
      // * up once its inbox's receiver attached
      await adapter.subscribe(['bead', 'i', 'flagged']);

      // * a name it may call beside one its access control denies, in one turn: the denied one
      // ends the session that sends to names
      const beside = settledOf(
        adapter.publish({ expiresAfter: 1_000, payload: Uint8Array.of(0), topic: NAME })
      );
      const denied = settledOf(
        adapter.publish({ payload: Uint8Array.of(1), topic: ['bead', 's', 'interop-ts'] })
      );

      expect(String(await denied)).toContain('amqp:unauthorized-access');
      expect(String(await beside)).toContain('amqp:unauthorized-access');
      expect(adapter.isLinked).toBe(true);
      // the next on a session of its own: a name no deployment provisioned, released
      expect(
        await adapter.publish({ payload: Uint8Array.of(2), topic: ['bead', 's', 'nobody'] })
      ).toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    } finally {
      await adapter.stop();
    }
  });

  test('refuses a name whose ATTACH names no source and is detached, whose session its broker ends, or past its broker’s channel-max, naming it, and keeps every other (spec 15.34)', async () => {
    const url = brokerUrl();
    const adapter = createAmqpBrokerAdapter({ id: 'quiet', password: AMQP_PASSWORD, url });
    const { downs } = heardOf(adapter);

    await adapter.start();

    try {
      await adapter.subscribe(['bead', 'i', 'quiet']);
      await adapter.subscribe(NAME);
      await expect(adapter.subscribe(['bead', 's', 'nobody'])).rejects.toThrow('amqp:not-found');
      await expect(adapter.subscribe(['bead', 's', 'interop-ts'])).rejects.toThrow(
        'amqp:unauthorized-access'
      );
      expect([downs, adapter.isLinked]).toEqual([[], true]);
    } finally {
      await adapter.stop();
    }
  });

  test('hands on a message whose body is other than one Data section, or whose payload passes its receive bound, as no parcel, its link kept (spec 15.36)', async () => {
    const url = brokerUrl();
    const receiving = createAmqpBrokerAdapter({
      id: 'busy',
      maximumMessageSize: 2_048,
      password: AMQP_PASSWORD,
      url,
    });
    const sending = createAmqpBrokerAdapter({ id: 'peer.1', password: AMQP_PASSWORD, url });
    const { downs, messages } = heardOf(receiving);
    const inbox = ['bead', 'i', 'busy'];

    receiving.on('message', (message) => {
      message.settle();
    });
    await receiving.start();
    await sending.start();

    try {
      await receiving.subscribe(inbox);

      // * a message of its broker's max_message_size, past its own bound, then one within it
      const largest = sending.maximumPayloadBytes(inbox);

      expect(largest).toBeGreaterThan(receiving.receiveBound(inbox));
      expect(await sending.publish({ payload: new Uint8Array(largest), topic: inbox })).toBe(
        BROKER_PUBLISHED.TAKEN
      );
      expect(await sending.publish({ payload: Uint8Array.of(5), topic: inbox })).toBe(
        BROKER_PUBLISHED.TAKEN
      );
      await until(() => {
        return messages.length === 2;
      });
      expect(
        messages.map(({ payload }) => {
          return [...payload];
        })
      ).toEqual([[], [5]]);
      expect([downs, receiving.isLinked, receiving.unsettled]).toEqual([[], true, 0]);
    } finally {
      await sending.stop();
      await receiving.stop();
    }
  });

  test('stops by detaching its receivers and closing its connection with no error, its inbox gone with it (spec 15.33)', async () => {
    const url = brokerUrl();
    const adapter = createAmqpBrokerAdapter({ id: 'other', password: AMQP_PASSWORD, url });
    const { downs } = heardOf(adapter);

    await adapter.start();
    await adapter.subscribe(['bead', 'i', 'other']);
    await adapter.subscribe(NAME);
    expect(await holdsQueue(url, 'bead.i.other')).toBe(true);
    await adapter.stop();

    for (let tries = 0; tries < 100 && (await holdsQueue(url, 'bead.i.other')); tries += 1) {
      await sleep(20);
    }

    expect(await holdsQueue(url, 'bead.i.other')).toBe(false);
    expect([downs, adapter.isLinked]).toEqual([[], false]);
  });

  test('carries a link through RabbitMQ’s topic exchange, a name’s queue consumed by two in turn (spec 15.32)', async () => {
    const url = brokerUrl();
    const ids = ['ada', 'bob'];
    const adapters = ids.map((id) => {
      return createAmqpBrokerAdapter({ id, password: AMQP_PASSWORD, url });
    });
    const caller = createAmqpBrokerAdapter({ id: 'coming', password: AMQP_PASSWORD, url });
    const heard: Map<string, number[]> = new Map(
      ids.map((id) => {
        return [id, []];
      })
    );
    const marker = 0xb7;

    for (const [index, adapter] of adapters.entries()) {
      adapter.on('message', (message) => {
        const [first, second] = message.payload;

        if (first === marker && second !== undefined) {
          heard.get(ids[index] ?? '')?.push(second);
        }

        message.settle();
      });
    }

    const fixture = await brokerConnectionOf(url, FIXTURE_USER);

    try {
      // * what earlier runs left in the name's queue purged
      await requestOf(fixture, { method: 'DELETE', path: '/queues/bead.s.interop/messages' });

      for (const [index, adapter] of adapters.entries()) {
        await adapter.start();
        await adapter.subscribe(['bead', 'i', ids[index] ?? '']);
        await adapter.subscribe(NAME, { group: 'interop' });
      }

      await caller.start();
      await caller.subscribe(['bead', 'i', 'coming']);

      for (let index = 0; index < 8; index += 1) {
        expect(
          await caller.publish({
            expiresAfter: 5_000,
            payload: Uint8Array.of(marker, index),
            topic: NAME,
          })
        ).toBe(BROKER_PUBLISHED.TAKEN);
      }

      await until(() => {
        return [...heard.values()].flat().length === 8;
      });

      // * each once, to one of the two, each of them some
      expect(
        [...heard.values()].flat().toSorted((left, right) => {
          return left - right;
        })
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      for (const each of heard.values()) {
        expect(each.length).toBeGreaterThan(0);
      }

      // an inbox's parcel taken, and one to an inbox no one holds released
      expect(
        await caller.publish({ payload: Uint8Array.of(marker, 9), topic: ['bead', 'i', 'ada'] })
      ).toBe(BROKER_PUBLISHED.TAKEN);
      await until(() => {
        return heard.get('ada')?.includes(9) === true;
      });
      expect(
        await caller.publish({ payload: Uint8Array.of(1), topic: ['bead', 'i', 'twin'] })
      ).toBe(BROKER_PUBLISHED.NO_SUBSCRIBER);
    } finally {
      fixture.close();
      await caller.stop();

      for (const adapter of adapters) {
        await adapter.stop();
      }
    }
  });
});
