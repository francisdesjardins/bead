// ── AMQP management ───────────────────────────────────────────────────────────

// RabbitMQ 4's management over AMQP 1.0 against a scripted peer, which reads each link, request and
// session end as it goes. The C# side's `AmqpManagementTests` play the same sentences.

// dependencies

import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import rhea, { type Connection } from 'rhea';
import { GenericError } from '../errors';
import { bindInbox, declareInbox, deleteInbox, requestOf } from '../amqp-management';
import { createAmqpScript, type IAmqpScript, type IAmqpScriptedLink } from './amqp-script';

// helpers

/** A connection of rhea's to `script`, its OPEN answered, and the script's end of it. */
const connectionTo = async (
  script: IAmqpScript
): Promise<{ connection: Connection; link: IAmqpScriptedLink }> => {
  const url = new URL(script.url);
  const container = rhea.create_container({ id: 'management-test' });

  container.on('error', () => {
    // read where it is held
  });

  const connection = container.connect({
    host: url.hostname,
    password: 'secret',
    port: Number(url.port),
    reconnect: false,
    username: 'ada',
  });

  connection.on('disconnected', () => {
    // read where it is held
  });
  await once(connection, 'connection_open');

  return { connection, link: await script.link() };
};

/** A request held by the script, under way, and its outcome as it settles. */
const heldRequest = (connection: Connection, path: string) => {
  return requestOf(connection, { method: 'GET', path }).then(
    (answer) => {
      return { answer };
    },
    (error: unknown) => {
      return { error };
    }
  );
};

// definition

test.describe('the AMQP management', () => {
  test.describe.configure({ timeout: 20_000 });

  let script: IAmqpScript;

  test.beforeEach(async () => {
    script = await createAmqpScript();
  });

  test.afterEach(async () => {
    await script[Symbol.asyncDispose]();
  });

  test('pairs its sender and receiver under one name on a session of its own, one after the other, and matches each answer by its correlation-id', async () => {
    const { connection, link } = await connectionTo(script);

    script.policy.answer = () => {
      return 'hold';
    };

    const asking = heldRequest(connection, '/queues/bead.i.ada');

    await link.until(() => {
      return link.requests.length === 1;
    });

    const [sender, receiver] = link.attaches;

    // * one name, one session, the sender's ATTACH first, the receiver's after it was answered
    expect(
      link.attaches.map(({ address, role }) => {
        return [address, role];
      })
    ).toEqual([
      ['/management', 'sender'],
      ['/management', 'receiver'],
    ]);
    expect(sender?.attach['name']).toBe(receiver?.attach['name']);
    expect(sender?.session).toBe(receiver?.session);
    expect(sender?.attach['properties']).toMatchObject({ paired: true });
    expect(link.sessions).toHaveLength(1);

    const [request] = link.requests;

    expect({ method: request?.method, path: request?.path }).toEqual({
      method: 'GET',
      path: '/queues/bead.i.ada',
    });

    // an answer naming another request is none of this one's
    request?.answer(200, { correlationId: 'another' });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    request?.answer(404, { body: 'not found' });
    expect(await asking).toEqual({ answer: { body: 'not found', status: 404 } });

    // * its session ended once answered
    await link.until(() => {
      return link.ended.includes(sender?.session as never);
    });

    // and each request a pair and a session of its own
    script.policy.answer = (asked) => {
      return asked.method === 'PUT' ? 201 : 204;
    };
    await declareInbox(connection, { queue: 'bead.i.ada' });
    expect(link.sessions).toHaveLength(2);
    expect(link.requests[1]?.body).toMatchObject({
      arguments: { 'x-queue-type': 'classic' },
      auto_delete: false,
      durable: false,
      exclusive: true,
    });

    // a binding answered other than 204, and a deletion other than 200, refused naming the answer
    script.policy.answer = (asked) => {
      return asked.method === 'POST' ? 403 : 404;
    };
    await expect(bindInbox(connection, { exchange: 'bead', queue: 'bead.i.ada' })).rejects.toThrow(
      'its broker answered the binding of bead.i.ada 403'
    );
    await expect(deleteInbox(connection, { queue: 'bead.i.ada' })).rejects.toThrow(
      'its broker answered the deletion of bead.i.ada 404'
    );
    expect(
      link.requests.slice(2).map(({ body, method, path }) => {
        return [method, path, body];
      })
    ).toEqual([
      [
        'POST',
        '/bindings',
        {
          arguments: {},
          binding_key: 'bead.i.ada',
          destination_queue: 'bead.i.ada',
          source: 'bead',
        },
      ],
      ['DELETE', '/queues/bead.i.ada', null],
    ]);
    connection.close();
  });

  test('fails each request under way when its link is detached, its session ends or its connection is lost, and matches no answer of an ended pair to a later request', async () => {
    const { connection, link } = await connectionTo(script);

    script.policy.answer = () => {
      return 'hold';
    };

    // its receiver detached by its peer
    const detached = heldRequest(connection, '/queues/one');

    await link.until(() => {
      return link.requests.length === 1;
    });
    (await link.attachOf('/management', { role: 'receiver' })).link.close({
      condition: 'amqp:internal-error',
      description: 'scripted',
    });

    const first = await detached;

    expect((first as { error: Error }).error).toBeInstanceOf(GenericError);
    expect(String((first as { error: Error }).error)).toContain(
      "the management's receiver ended as it asked GET /queues/one: amqp:internal-error"
    );

    // its session ended by its peer
    const ending = heldRequest(connection, '/queues/two');

    await link.until(() => {
      return link.requests.length === 2;
    });
    link.attaches[2]?.session.close({ condition: 'amqp:unauthorized-access' });
    expect(String(((await ending) as { error: Error }).error)).toContain(
      "the management's session ended as it asked GET /queues/two: amqp:unauthorized-access"
    );

    // * a later request takes no answer of an ended pair's request, only its own
    const later = heldRequest(connection, '/queues/three');

    await link.until(() => {
      return link.requests.length === 3;
    });
    link.requests[2]?.answer(200, { correlationId: link.requests[0]?.messageId });
    link.requests[2]?.answer(200, { correlationId: link.requests[1]?.messageId });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    link.requests[2]?.answer(204);
    expect(await later).toEqual({ answer: { body: null, status: 204 } });

    // its connection lost
    const losing = heldRequest(connection, '/queues/four');

    await link.until(() => {
      return link.requests.length === 4;
    });
    link.cut();
    expect(String(((await losing) as { error: Error }).error)).toContain(
      "the management's connection ended as it asked GET /queues/four"
    );

    // and a signal aborted fails it, its session ended
    await expect(
      requestOf(connection, { method: 'GET', path: '/queues/five', signal: AbortSignal.abort() })
    ).rejects.toThrow();
  });
});
