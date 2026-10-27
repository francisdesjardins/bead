// ── AMQP script ───────────────────────────────────────────────────────────────

// A scripted AMQP 1.0 peer on the loopback, over rhea's own `container.listen`, which the adapter's
// tests play a broker with: each session, link, message and management request recorded as it
// comes, each answer its policy's or the test's, so that nothing a real broker does hides what the
// adapter sends.

// dependencies

import { once } from 'node:events';
import type { Server, Socket } from 'node:net';
import rhea, {
  type AmqpError,
  type Connection,
  type Delivery,
  type EventContext,
  type Message,
  type Receiver,
  type Sender,
  type Session,
} from 'rhea';

// interfaces

/** A link the adapter attached, as the script holds its other end. */
export interface IScriptedAttach {
  /** The address it names: its source's for the adapter's receiver, its target's for its sender. */
  readonly address: string | undefined;
  /** Its ATTACH, as the adapter wrote it. */
  readonly attach: Record<string, unknown>;
  /** The script's end: a sender where the adapter's is a receiver, a receiver where a sender. */
  readonly link: Receiver | Sender;
  /** The adapter's end of it. */
  readonly role: 'receiver' | 'sender';
  readonly session: Session;
}

/** A message the adapter published, its bytes as they came and its delivery, to settle. */
export interface IScriptedDelivery {
  readonly bytes: Uint8Array;
  readonly delivery: Delivery;
  readonly message: Message;
  readonly receiver: Receiver;
}

/** A request of the adapter to its broker's management. */
export interface IScriptedRequest {
  readonly body: unknown;
  /** Its message-id, which its answer's correlation-id names. */
  readonly messageId: string;
  readonly method: string;
  readonly path: string;
  /** Answers it on its pair, with a status and a body, naming its message-id unless told another. */
  answer(status: number, options?: { body?: unknown; correlationId?: string | undefined }): void;
}

/** What the script does with what comes, unless a test answers it itself. */
export interface IAmqpScriptPolicy {
  /** A management request's status, or `hold` to answer nothing. */
  answer: (request: IScriptedRequest) => number | 'hold';
  /** An ATTACH taken, held unanswered, refused by a DETACH, or ended with its session. */
  attach: (
    attach: Pick<IScriptedAttach, 'address' | 'role'>
  ) => 'hold' | 'take' | { refuse: AmqpError } | { endSession: AmqpError };
  /** The credit granted each of the adapter's senders as it attaches. */
  credit: number;
  /** A DETACH of the adapter's answered, or held unanswered until a test releases it. */
  detach: (attach: Pick<IScriptedAttach, 'address' | 'role'>) => 'answer' | 'hold';
  /** The max-message-size the script's ATTACH names to each of the adapter's senders. */
  maximumMessageSize: number | undefined;
  /** How each publication is settled, or `hold` to settle it later. */
  settle: (
    delivery: IScriptedDelivery
  ) => 'accepted' | 'hold' | 'modified' | 'rejected' | 'released';
}

/** One network connection to the script: what came on it, and what the test writes back. */
export interface IAmqpScriptedLink {
  /** Every link the adapter attached, in its order. */
  readonly attaches: IScriptedAttach[];
  /** The CLOSE the adapter sent, its error among it; `undefined` while it sent none. */
  readonly closeFrame: { error?: unknown } | undefined;
  readonly connection: Connection;
  /** Every message the adapter published, in its order. */
  readonly deliveries: IScriptedDelivery[];
  /** The links the adapter detached, in their order. */
  readonly detached: IScriptedAttach[];
  /** The sessions the adapter ended, in their order. */
  readonly ended: Session[];
  /** Whether the adapter's end of it closed. */
  readonly isClosed: boolean;
  /** The adapter's OPEN. */
  readonly open: Record<string, unknown>;
  /** What SASL PLAIN carried, where the adapter authenticated by it. */
  readonly plain: { password: string; username: string } | undefined;
  /** Every management request, in its order. */
  readonly requests: IScriptedRequest[];
  /** Every session the adapter began, in its order. */
  readonly sessions: Session[];
  /** Resolves once the adapter's end closed. */
  readonly closed: Promise<void>;
  /** Ends it at once, as a broker that drops a link does. */
  cut(): void;
  /** The link the adapter attached to `address`, in `role`, within `within` ms. */
  attachOf(
    address: string,
    options?: { role?: 'receiver' | 'sender' | undefined; within?: number | undefined }
  ): Promise<IScriptedAttach>;
  /** Answers what the policy held: each ATTACH held, in its order. */
  releaseAttaches(): void;
  /** Answers each DETACH the policy held, in its order. */
  releaseDetaches(): void;
  /** Holds until `isDone`, within `within` ms; refuses past it. */
  until(isDone: () => boolean, options?: { within?: number | undefined }): Promise<void>;
}

/** The script: its address, its policy, each link as it comes, and what closes it. */
export interface IAmqpScript extends AsyncDisposable {
  readonly policy: IAmqpScriptPolicy;
  readonly url: string;
  /** The next link that comes, its OPEN read, within `within` ms. */
  link(options?: { within?: number | undefined }): Promise<IAmqpScriptedLink>;
}

// constants

const PATIENCE = 5_000;

const POLL = 5;

// ! each message's bytes, as they came, by the message rhea decodes them into: rhea hands on none
const RAW = new WeakMap<object, Uint8Array>();
const writable = rhea.message as unknown as { decode: (buffer: Buffer) => object };
const decode = writable.decode.bind(writable);

writable.decode = (buffer: Buffer): object => {
  const decoded = decode(buffer);

  RAW.set(decoded, new Uint8Array(buffer));

  return decoded;
};

// helpers

const sleep = (milliseconds: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

/** What RabbitMQ 4's management answers a request it takes. */
const statusOf = ({ method }: { method: string }): number => {
  return method === 'PUT' ? 201 : method === 'POST' ? 204 : 200;
};

const addressOf = (terminus: unknown): string | undefined => {
  const { address } = (terminus ?? {}) as { address?: unknown };

  return typeof address === 'string' ? address : undefined;
};

// the address of a terminus as its ATTACH carries it, described and not yet read: its first field
const rawAddressOf = (terminus: unknown): string | undefined => {
  const fields = (terminus as { value?: unknown } | null | undefined)?.value;
  const [first] = Array.isArray(fields) ? (fields as unknown[]) : [];
  const value = (first as { value?: unknown } | undefined)?.value;

  return typeof value === 'string' ? value : addressOf(terminus);
};

// definition

/**
 * A scripted AMQP 1.0 peer on 127.0.0.1, on a port of its own, its management answering as RabbitMQ
 * 4's does unless told, 201 to a declaration, 204 to a binding and 200 to a deletion, offering SASL
 * PLAIN: over TCP, or
 * over TLS under `tls`'s certificate, `amqps://localhost`, asking a client certificate and offering
 * SASL EXTERNAL to one it trusts; its OPEN of `channelMax` where given.
 */
export const createAmqpScript = async (options?: {
  channelMax?: number | undefined;
  tls?: { cert: string; key: string } | undefined;
}): Promise<IAmqpScript> => {
  const links: IAmqpScriptedLink[] = [];
  const connections = new Set<Connection>();
  const waiting: (() => void)[] = [];
  const policy: IAmqpScriptPolicy = {
    answer: statusOf,
    attach: () => {
      return 'take';
    },
    credit: 1_000,
    detach: () => {
      return 'answer';
    },
    maximumMessageSize: undefined,
    settle: () => {
      return 'accepted';
    },
  };
  const container = rhea.create_container({ id: 'script' });
  // the PLAIN each connection authenticated by, as it came
  const plains = new WeakMap<object, { password: string; username: string }>();
  const tls = options?.tls;

  const mechanisms = container.sasl_server_mechanisms as unknown as {
    enable_plain: (verify: (username: string, password: string) => boolean) => void;
  };

  mechanisms.enable_plain((username: string, password: string) => {
    // * recorded by the link whose SASL it is, once its OPEN comes
    lastPlain = { password, username };

    return true;
  });

  let lastPlain: { password: string; username: string } | undefined;

  container.on('error', () => {
    // each endpoint's end is the test's to read
  });
  container.on('disconnected', () => {
    // a connection that ended before its OPEN came is no link
  });
  container.on('connection_open', (context: EventContext) => {
    const { connection } = context;
    const attaches: IScriptedAttach[] = [];
    const deliveries: IScriptedDelivery[] = [];
    const detached: IScriptedAttach[] = [];
    const ended: Session[] = [];
    const requests: IScriptedRequest[] = [];
    const sessions: Session[] = [];
    const held: (() => void)[] = [];
    const heldDetaches: (() => void)[] = [];
    let isClosed = false;
    let closeFrame: { error?: unknown } | undefined;
    const socket = (connection as unknown as { socket: Socket }).socket;
    // ! its close, whatever error came before it: `once` would refuse on the first
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        isClosed = true;
        resolve();
      });
    });

    if (lastPlain !== undefined) {
      plains.set(connection, lastPlain);
    }

    lastPlain = undefined;
    connections.add(connection);

    // the script's sender paired with the management receiver of the session, which answers
    const answerer = new WeakMap<Session, Sender>();

    const taken = (attach: IScriptedAttach): void => {
      attaches.push(attach);

      if (attach.role === 'sender') {
        const receiver = attach.link as Receiver;

        if (policy.maximumMessageSize !== undefined) {
          (receiver as unknown as { local: { attach: Record<string, unknown> } }).local.attach[
            'max_message_size'
          ] = policy.maximumMessageSize;
        }

        receiver.set_target((attach.attach['target'] ?? {}) as never);
        receiver.add_credit(policy.credit);
      } else {
        const sender = attach.link as Sender;

        sender.set_source((attach.attach['source'] ?? {}) as never);

        if (attach.address === '/management') {
          answerer.set(attach.session, sender);
        }
      }
    };

    const attached = (context: EventContext, role: 'receiver' | 'sender'): void => {
      const link = (role === 'sender' ? context.receiver : context.sender) as Receiver | Sender;
      const remote = (link as unknown as { remote: { attach: Record<string, unknown> } }).remote
        .attach;
      const address = addressOf(role === 'sender' ? remote['target'] : remote['source']);
      const attach: IScriptedAttach = {
        address,
        attach: remote,
        link,
        role,
        session: context.session as Session,
      };
      const decided = address === '/management' ? 'take' : policy.attach({ address, role });

      if (decided === 'take' || decided === 'hold') {
        taken(attach);

        return;
      }

      attaches.push(attach);

      // * a refusal as AMQP 1.0 §2.6.3 writes one: an ATTACH of no terminus, then a DETACH
      if ('refuse' in decided) {
        setImmediate(() => {
          link.close(decided.refuse);
        });
      } else {
        attach.session.close(decided.endSession);
      }
    };

    connection.on('session_open', (opened: EventContext) => {
      const session = opened.session as Session;
      const onAttach = (session as unknown as { on_attach: (frame: unknown) => void }).on_attach;

      sessions.push(session);

      // * an ATTACH the policy holds is answered once a test releases it
      (session as unknown as { on_attach: (frame: unknown) => void }).on_attach = (frame) => {
        const performative = (frame as { performative: Record<string, unknown> }).performative;
        const role = performative['role'] === true ? 'receiver' : 'sender';
        const address = rawAddressOf(
          role === 'sender' ? performative['target'] : performative['source']
        );

        // ! rhea keys a session's links by their name alone: the second link of a pair would be
        // taken for the first, so the first leaves the index, its frames still found by its handle
        const links = (session as unknown as { links: Record<string, Receiver | Sender> }).links;
        const name = String(performative['name']);
        const named = links[name];

        if (named !== undefined && named.is_receiver() === (role === 'receiver')) {
          // oxlint-disable-next-line typescript/no-dynamic-delete -- rhea's own index, by name
          delete links[name];
        }

        if (address !== '/management' && policy.attach({ address, role }) === 'hold') {
          held.push(() => {
            onAttach.call(session, frame);
          });

          return;
        }

        onAttach.call(session, frame);
      };

      // * a DETACH the policy holds is answered, and heard, once a test releases it
      const onDetach = (session as unknown as { on_detach: (frame: unknown) => void }).on_detach;

      (session as unknown as { on_detach: (frame: unknown) => void }).on_detach = (frame) => {
        const handle = (frame as { performative: { handle?: unknown } }).performative.handle;
        const link = (session as unknown as { remote: { handles: Record<string, unknown> } }).remote
          .handles[String(handle)];
        const found = attaches.find((attach) => {
          return attach.link === link;
        });

        if (found !== undefined && policy.detach(found) === 'hold') {
          detached.push(found);
          heldDetaches.push(() => {
            onDetach.call(session, frame);
          });

          return;
        }

        onDetach.call(session, frame);
      };
    });
    connection.on('session_close', (closing: EventContext) => {
      ended.push(closing.session as Session);
    });
    connection.on('session_error', () => {
      // its close is recorded
    });
    connection.on('receiver_open', (opened: EventContext) => {
      attached(opened, 'sender');
    });
    connection.on('sender_open', (opened: EventContext) => {
      attached(opened, 'receiver');
    });
    connection.on('receiver_close', (closing: EventContext) => {
      const found = attaches.find(({ link }) => {
        return link === closing.receiver;
      });

      if (found !== undefined && !detached.includes(found)) {
        detached.push(found);
      }
    });
    connection.on('sender_close', (closing: EventContext) => {
      const found = attaches.find(({ link }) => {
        return link === closing.sender;
      });

      if (found !== undefined && !detached.includes(found)) {
        detached.push(found);
      }
    });
    connection.on('receiver_error', () => {
      // its close is recorded
    });
    connection.on('sender_error', () => {
      // its close is recorded
    });
    connection.on('connection_close', (closing: EventContext) => {
      closeFrame = { error: (closing.connection as unknown as { error?: unknown }).error };
    });
    connection.on('connection_error', () => {
      // its close is recorded
    });
    connection.on('disconnected', () => {
      // its socket's close is recorded
    });
    connection.on('error', () => {
      // its socket's close is recorded
    });
    connection.on('sendable', () => {
      // a script's sender sends what a test asks, credit or not
    });
    connection.on('message', (received: EventContext) => {
      const receiver = received.receiver as Receiver;
      const message = received.message as Message;
      const delivery = received.delivery as Delivery;
      const target = addressOf(
        (receiver as unknown as { remote: { attach: Record<string, unknown> } }).remote.attach[
          'target'
        ]
      );

      // * a management request, answered on its pair's receiver
      if (target === '/management') {
        const request: IScriptedRequest = {
          answer: (status, answerOptions) => {
            answerer.get(received.session as Session)?.send({
              body: answerOptions?.body ?? null,
              correlation_id: answerOptions?.correlationId ?? (message.message_id as string),
              subject: String(status),
            });
          },
          body: message.body,
          messageId: String(message.message_id),
          method: String(message.subject),
          path: String(message.to),
        };
        const status = policy.answer(request);

        requests.push(request);

        if (status !== 'hold') {
          request.answer(status);
        }

        return;
      }

      const scripted: IScriptedDelivery = {
        bytes: RAW.get(message) ?? new Uint8Array(0),
        delivery,
        message,
        receiver,
      };
      const settled = policy.settle(scripted);

      deliveries.push(scripted);

      if (settled === 'accepted') {
        delivery.accept();
      } else if (settled === 'released') {
        delivery.release();
      } else if (settled === 'rejected') {
        delivery.reject({ condition: 'amqp:precondition-failed', description: 'scripted' });
      } else if (settled === 'modified') {
        delivery.modified({ delivery_failed: true });
      }
    });

    const until = async (
      isDone: () => boolean,
      untilOptions?: { within?: number | undefined }
    ): Promise<void> => {
      const deadline = Date.now() + (untilOptions?.within ?? PATIENCE);

      while (!isDone()) {
        if (Date.now() >= deadline) {
          throw new Error('what the script awaited did not come within its time');
        }

        await sleep(POLL);
      }
    };

    links.push({
      attaches,
      get closeFrame() {
        return closeFrame;
      },
      closed,
      connection,
      deliveries,
      detached,
      ended,
      get isClosed() {
        return isClosed;
      },
      open: (connection as unknown as { remote: { open: Record<string, unknown> } }).remote.open,
      get plain() {
        return plains.get(connection);
      },
      requests,
      sessions,
      attachOf: async (address, attachOptions) => {
        const found = (): IScriptedAttach | undefined => {
          return attaches.find((attach) => {
            return (
              attach.address === address &&
              (attachOptions?.role === undefined || attach.role === attachOptions.role)
            );
          });
        };

        await until(
          () => {
            return found() !== undefined;
          },
          { within: attachOptions?.within }
        );

        return found() as IScriptedAttach;
      },
      cut: () => {
        socket.resetAndDestroy();
      },
      releaseAttaches: () => {
        for (const release of held.splice(0)) {
          release();
        }
      },
      releaseDetaches: () => {
        for (const release of heldDetaches.splice(0)) {
          release();
        }
      },
      until,
    });

    for (const wake of waiting.splice(0)) {
      wake();
    }
  });

  const server = container.listen({
    host: '127.0.0.1',
    port: 0,
    receiver_options: { autoaccept: false, credit_window: 0 },
    ...(options?.channelMax === undefined ? {} : { channel_max: options.channelMax }),
    ...(tls === undefined
      ? {}
      : {
          ca: tls.cert,
          cert: tls.cert,
          enable_sasl_external: true,
          key: tls.key,
          rejectUnauthorized: false,
          requestCert: true,
          transport: 'tls',
        }),
  } as never) as unknown as Server;

  await once(server, 'listening');

  const { port } = server.address() as { port: number };

  return {
    policy,
    url: `${tls === undefined ? 'amqp://127.0.0.1' : 'amqps://localhost'}:${String(port)}`,
    link: async (linkOptions) => {
      const deadline = Date.now() + (linkOptions?.within ?? PATIENCE);

      while (links.length === 0) {
        if (Date.now() >= deadline) {
          throw new Error('no link came within its time');
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));

          waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      return links.shift() as IAmqpScriptedLink;
    },
    [Symbol.asyncDispose]: async () => {
      for (const connection of connections) {
        (connection as unknown as { socket?: { destroy(): void } }).socket?.destroy();
      }

      server.close();
      await once(server, 'close');
    },
  };
};
