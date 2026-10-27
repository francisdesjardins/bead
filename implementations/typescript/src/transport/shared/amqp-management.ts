// ── AMQP management ───────────────────────────────────────────────────────────

// RabbitMQ 4's management over AMQP 1.0, on the connection it is asked on (spec 15.33; AMQP
// Request-Response Messaging with Link Pairing v1.0, HTTP over AMQP): each request a pair of its
// own, a sender then a receiver of one name, on a session that ends with the request.

// dependencies

import rhea, { type Connection, type EventContext, type Receiver, type Sender } from 'rhea';
import { GenericError, toCancelError } from './errors';

// interfaces

/** A request of the management: its method, its path, and its body, where it has one. */
export interface IAmqpManagementRequest {
  readonly body?: unknown;
  readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  readonly path: string;
  readonly signal?: AbortSignal | undefined;
}

/** What the management answered: its status, the answer's subject, and its body. */
export interface IAmqpManagementAnswer {
  readonly body: unknown;
  readonly status: number;
}

// constants

/** The address of RabbitMQ 4's management node. */
export const MANAGEMENT_ADDRESS = '/management';

// the name of the pair, as RabbitMQ's own clients name it
const PAIR_NAME = 'management-link-pair';

// helpers

// the condition and description an ended endpoint carries, as a refusal names it
const conditionOf = (error: unknown): string => {
  const { condition, description } = (error ?? {}) as {
    condition?: unknown;
    description?: unknown;
  };

  if (typeof condition !== 'string') {
    return 'no error';
  }

  return typeof description === 'string' && description !== ''
    ? `${condition}, ${description}`
    : condition;
};

// each request's message-id, which its answer's correlation-id names: one counter for every pair
let requests = 0;

// definition

/**
 * One request of RabbitMQ's management over `connection`, answered by its status: on a session of
 * its own, its pair opened one link after the other, its request sent pre-settled, its answer the
 * one whose correlation-id names it, accepted, then its session ended. It fails as either link is
 * detached, its session ends, its connection ends, or its signal aborts, and no answer of an ended
 * pair is taken by another. Since rhea keys a session's links by their name alone, a receiver opened
 * beside its same-named sender would replace it in that index: so the sender's ATTACH is answered
 * before the receiver's goes, and the session ends after each request, no entry it evicted
 * outliving it. Nothing is settled but `accepted`, since rhea batches adjacent dispositions of
 * mixed outcomes under the first.
 */
export const requestOf = (
  connection: Connection,
  request: IAmqpManagementRequest
): Promise<IAmqpManagementAnswer> => {
  const { body = null, method, path, signal } = request;

  requests += 1;

  const messageId = `bead-${String(requests)}`;

  return new Promise<IAmqpManagementAnswer>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(toCancelError(signal));

      return;
    }

    const session = connection.create_session();
    const common = {
      name: PAIR_NAME,
      properties: { paired: true },
      rcv_settle_mode: 0,
      snd_settle_mode: 1,
      source: { address: MANAGEMENT_ADDRESS },
      target: { address: MANAGEMENT_ADDRESS },
    };
    let receiver: Receiver | undefined;
    let isSettled = false;

    const detach = (): void => {
      connection.removeListener('disconnected', lost);
      connection.removeListener('connection_close', lost);
      signal?.removeEventListener('abort', abort);
    };
    // * the session ended, whatever came: what it held goes with it
    const end = (): void => {
      try {
        session.close();
      } catch {
        // its connection ended already
      }
    };
    const fail = (error: Error): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      detach();
      end();
      reject(error);
    };
    const lost = (): void => {
      fail(new GenericError(`the management's connection ended as it asked ${method} ${path}`));
    };
    const abort = (): void => {
      fail(toCancelError(signal as AbortSignal));
    };
    const ended = (what: string) => {
      return (context: EventContext): void => {
        const error = (context.receiver ?? context.sender ?? context.session)?.error;

        fail(
          new GenericError(
            `the management's ${what} ended as it asked ${method} ${path}: ${conditionOf(error)}`
          )
        );
      };
    };
    const send = (): void => {
      if (isSettled) {
        return;
      }

      sender.send({
        body,
        message_id: messageId,
        reply_to: '$me',
        subject: method,
        to: path,
      });
    };

    connection.on('disconnected', lost);
    connection.on('connection_close', lost);
    signal?.addEventListener('abort', abort, { once: true });
    session.on('session_error', ended('session'));
    session.on('session_close', ended('session'));
    session.begin();

    const sender: Sender = session.open_sender(common);

    sender.on('sender_error', ended('sender'));
    sender.on('sender_close', ended('sender'));
    // * the receiver opened once the sender's ATTACH was answered, never beside it
    sender.once('sender_open', () => {
      if (isSettled) {
        return;
      }

      receiver = session.open_receiver({ ...common, autoaccept: false, credit_window: 0 });
      // ! its credit granted with its ATTACH, before its request goes: rhea writes a session's
      // transfers before its links' FLOWs, and RabbitMQ ends a session asked with none
      receiver.add_credit(1);
      receiver.on('receiver_error', ended('receiver'));
      receiver.on('receiver_close', ended('receiver'));
      receiver.once('receiver_open', () => {
        if (sender.sendable()) {
          send();
        } else {
          sender.once('sendable', send);
        }
      });
      receiver.on('message', (context: EventContext) => {
        const { delivery, message } = context;
        const answered = message?.correlation_id;

        delivery?.accept();

        // ! an answer to another request is none of this one's
        if (isSettled || answered !== messageId) {
          receiver?.add_credit(1);

          return;
        }

        isSettled = true;
        detach();
        end();
        resolve({ body: message?.body, status: Number(message?.subject) });
      });
    });
  });
};

/** A queue's path, its name percent-encoded as one segment (RFC 3986 §2.1). */
export const queuePathOf = (queue: string): string => {
  return `/queues/${encodeURIComponent(queue)}`;
};

/**
 * Declares `queue` an inbox on `connection`: exclusive to it, classic and not durable, so that it
 * ends with it; answered 200 or 201 (spec 15.33).
 */
export const declareInbox = async (
  connection: Connection,
  { queue, signal }: { queue: string; signal?: AbortSignal | undefined }
): Promise<void> => {
  const { body, status } = await requestOf(connection, {
    body: rhea.types.wrap_map({
      arguments: rhea.types.wrap_map({ 'x-queue-type': 'classic' }),
      auto_delete: false,
      durable: false,
      exclusive: true,
    }),
    method: 'PUT',
    path: queuePathOf(queue),
    signal,
  });

  if (status !== 200 && status !== 201) {
    throw new GenericError(
      `its broker answered the declaration of ${queue} ${answerOf(status, body)}`
    );
  }
};

/** Binds `queue` to the topic exchange `exchange` by its own name; answered 204 (spec 15.33). */
export const bindInbox = async (
  connection: Connection,
  { exchange, queue, signal }: { exchange: string; queue: string; signal?: AbortSignal | undefined }
): Promise<void> => {
  const { body, status } = await requestOf(connection, {
    body: rhea.types.wrap_map({
      arguments: rhea.types.wrap_map({}),
      binding_key: queue,
      destination_queue: queue,
      source: exchange,
    }),
    method: 'POST',
    path: '/bindings',
    signal,
  });

  if (status !== 204) {
    throw new GenericError(`its broker answered the binding of ${queue} ${answerOf(status, body)}`);
  }
};

/** Deletes `queue`, an inbox let go; answered 200 (spec 15.34). */
export const deleteInbox = async (
  connection: Connection,
  { queue, signal }: { queue: string; signal?: AbortSignal | undefined }
): Promise<void> => {
  const { body, status } = await requestOf(connection, {
    method: 'DELETE',
    path: queuePathOf(queue),
    signal,
  });

  if (status !== 200) {
    throw new GenericError(
      `its broker answered the deletion of ${queue} ${answerOf(status, body)}`
    );
  }
};

/** A status as a refusal names it, with what its body says where it says something. */
export const answerOf = (status: number, body: unknown): string => {
  return typeof body === 'string' && body !== '' ? `${String(status)}: ${body}` : String(status);
};
