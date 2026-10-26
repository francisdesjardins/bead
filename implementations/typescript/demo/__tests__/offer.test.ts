import { expect, test } from '@playwright/test';
import { createClient } from '../../src/client/client';
import { FailureError, ProtocolCode } from '../../src/client/ws-client';
import { createMetricsRegistry } from '../../src/router/shared/metrics-registry';
import { createServer } from '../../src/server/server';
import { violationsOf } from '../../src/service/service';
import { createMemoryTransportClient } from '../../src/transport/client/memory-transport-client';
import { createMemoryTransportServer } from '../../src/transport/server/memory-transport-server';
import { SignUpClient } from '../gen/typescript/demo/v1/sign_up_bead';
import { offer } from '../offer';

// constants

/** Every field of it breaks a rule, and the message's own rule too: an email and a phone both. */
const BROKEN = Object.freeze({
  email: 'ada@example',
  name: '9 Lives!',
  phone: '555-0100',
  seats: 12,
});

/** What a refusal of {@link BROKEN} carries, in the order spec 18.5 gives. */
const BROKEN_VIOLATIONS = Object.freeze([
  {
    fieldPath: 'name',
    message: 'does not match regex pattern `^[a-z][a-z0-9-]*$`',
    ruleId: 'string.pattern',
  },
  {
    fieldPath: 'seats',
    message: 'must be greater than or equal to 1 and less than or equal to 10',
    ruleId: 'int32.gte_lte',
  },
  { fieldPath: 'email', ruleId: 'string.pattern' },
  { fieldPath: 'phone', ruleId: 'string.pattern' },
  { message: 'only one of email, phone can be set', ruleId: 'message.oneof' },
]);

// helpers

/**
 * The demo's procedures offered on a server joined in memory to a client, connected; what the
 * server's transport heard, a message each; and the sign-up's client sides, the one that judges
 * before it sends among them.
 */
const connected = async () => {
  const transport = createMemoryTransportServer();
  const server = createServer({ transport });
  const client = createClient({ transport: createMemoryTransportClient({ server: transport }) });
  const heard: unknown[] = [];

  offer(server, createMetricsRegistry());
  transport.on('message', (message) => {
    heard.push(message);
  });
  await transport.start();
  await client.connect({});

  return {
    heard,
    judged: new SignUpClient(client, { validates: true }),
    sent: new SignUpClient(client),
    [Symbol.asyncDispose]: async () => {
      await client.disconnect();
      await transport.stop();
    },
  };
};

/** What a call that must fail threw. */
const thrownBy = async (call: Promise<unknown>): Promise<unknown> => {
  return call.then(
    () => {
      throw new Error('the call was answered');
    },
    (reason: unknown) => {
      return reason;
    }
  );
};

// definition

test.describe('offer', () => {
  test('signs up a request its rules take, its resolver answering', async () => {
    await using pair = await connected();

    const { welcome } = await pair.sent.signUp({
      email: 'ada@example.org',
      name: 'ada',
      seats: 2,
    })();

    expect(welcome).toBe('welcome, ada: 2 seats held, confirmed by email to ada@example.org');
  });

  test('answers a request its rules refuse PAYLOAD_INVALID, each violation by its path', async () => {
    await using pair = await connected();

    const reason = await thrownBy(pair.sent.signUp(BROKEN)());

    expect(reason).toBeInstanceOf(FailureError);
    expect((reason as FailureError).code).toBe(ProtocolCode.PAYLOAD_INVALID);
    expect((reason as FailureError).origin).toBe('peer');

    const read = violationsOf(reason as FailureError);

    expect(read.more).toBe(0);
    expect(read.violations).toMatchObject([...BROKEN_VIOLATIONS]);
    // * the message's own rule names no field
    expect(read.violations.at(-1)?.fieldPath).toBeUndefined();
  });

  test('refuses, judging first, before anything goes, with the same violations', async () => {
    await using pair = await connected();
    const before = pair.heard.length;

    const reason = await thrownBy(pair.judged.signUp(BROKEN)());

    expect((reason as FailureError).code).toBe(ProtocolCode.PAYLOAD_INVALID);
    expect((reason as FailureError).origin).toBe('local');
    expect(violationsOf(reason as FailureError).violations).toMatchObject([...BROKEN_VIOLATIONS]);
    expect(pair.heard).toHaveLength(before);

    // the same request sent unjudged reaches the server, which refuses it
    await thrownBy(pair.sent.signUp(BROKEN)());

    expect(pair.heard.length).toBeGreaterThan(before);
  });

  test('refuses a request of neither an email nor a phone by the message’s own rule', async () => {
    await using pair = await connected();

    const reason = await thrownBy(pair.sent.signUp({ name: 'ada', seats: 1 })());

    expect(violationsOf(reason as FailureError)).toEqual({
      more: 0,
      violations: [
        {
          bounds: { fields: ['email', 'phone'], required: true },
          message: 'one of email, phone must be set',
          ruleId: 'message.oneof',
        },
      ],
    });
  });
});
