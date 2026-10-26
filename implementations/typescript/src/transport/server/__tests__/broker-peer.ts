// ── Broker peer ───────────────────────────────────────────────────────────────

// The test's own participants of the in-memory broker, as `spec/transports.json` plays them: each
// publishes the parcels a case writes by their fields and reads its inbox, answering nothing of its
// own.

// dependencies

import {
  type IExpected,
  expectedOf,
  failureDetailOf,
  hexadecimalOf,
} from '../../../router/server/__tests__/expected-envelope';
import { fromHexadecimal } from '../../../router/shared/__tests__/vectors';
import { encodeParcel, readParcel } from '../../shared/broker-parcel';
import {
  BROKER_PUBLISHED,
  type BrokerPublished,
  type BrokerTopic,
  type IMemoryBroker,
  type IMemoryBrokerAdapter,
} from '../../shared/memory-broker';

// interfaces

/** A value of the side under test, kept under `capture` as it is first read. */
export interface ICaptured {
  capture: string;
  shape: 'half' | 'incarnation';
}

/** A parcel as a case writes it, to publish or to read, each half a value, a `{name}` or a capture. */
export interface IParcelFields {
  acceptor: ICaptured | string;
  answers?: number;
  bound?: number;
  code?: number;
  credential?: string;
  envelope?: IExpected | string;
  flags: number;
  id?: string;
  incarnation?: ICaptured | string;
  kind: number;
  layouts?: number[];
  opener: ICaptured | string;
  part?: string;
  sequence: number;
  status?: number;
}

/** What a peer publishes in one turn, in its order: parcels by their fields, or bytes. */
export interface IPublication {
  from: string;
  publish: ({ bytes: string } | { parcel: IParcelFields })[];
  refused?: 'no-subscriber';
  retained?: true;
  to: 'departure' | 'inbox' | 'name';
}

/** A message a peer was handed: its topic, and its bytes. */
export interface IHeardMessage {
  readonly payload: Uint8Array;
  readonly topic: BrokerTopic;
}

/** The test's participants, by their ids. */
export interface IBrokerPeers {
  /** The next message `id` is handed, or none within `within` milliseconds. */
  next(id: string, within: number): Promise<IHeardMessage | undefined>;
  /** Publishes `publication` in one turn, none awaited before the next; resolves with what the broker said. */
  publish(
    publication: IPublication,
    values: ReadonlyMap<string, string>
  ): Promise<BrokerPublished[]>;
}

// constants

const ROOT = 'bead';

const SHAPE_BYTES: Readonly<Record<ICaptured['shape'], number>> = Object.freeze({
  half: 8,
  incarnation: 16,
});

// helpers

/** Hexadecimal with each `{name}` put in as the value captured under it. */
export const filledOf = (text: string, values: ReadonlyMap<string, string>): string => {
  return text.replaceAll(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = values.get(name);

    if (value === undefined) {
      throw new Error(`nothing captured under ${name}`);
    }

    return value;
  });
};

const bytesOfField = (
  value: ICaptured | string | undefined,
  values: ReadonlyMap<string, string>
): Uint8Array | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error('a parcel published names no capture');
  }

  return fromHexadecimal(filledOf(value, values));
};

/** The bytes a case's parcel writes, by this side's codec. */
export const parcelBytesOf = (
  fields: IParcelFields,
  values: ReadonlyMap<string, string>
): Uint8Array => {
  const { acceptor, envelope, incarnation, opener, part, ...rest } = fields;
  const carried = typeof envelope === 'object' ? undefined : (envelope ?? part);

  return encodeParcel({
    ...rest,
    acceptor: bytesOfField(acceptor, values) ?? new Uint8Array(8),
    ...(carried === undefined ? {} : { carried: fromHexadecimal(carried) }),
    ...(incarnation === undefined ? {} : { incarnation: bytesOfField(incarnation, values) }),
    opener: bytesOfField(opener, values) ?? new Uint8Array(8),
  });
};

/** A message's envelope as a case expects it: a failure's detail where `expected` gives one. */
const envelopeOf = (bytes: Uint8Array, expected: IExpected): IExpected | string => {
  const actual = expectedOf(bytes);

  if (actual === undefined) {
    return hexadecimalOf(bytes);
  }

  return actual.failure !== undefined && expected.failure?.detail !== undefined
    ? { ...actual, failure: { ...actual.failure, detail: failureDetailOf(bytes) } }
    : actual;
};

/**
 * What a message reads as, in the terms `expected` names it by: each half or incarnation as the
 * expected value, its `{name}` put in, or as the capture it matched in shape, which `values` keeps;
 * a field the parcel has that `expected` names none of shows as itself, so the comparison fails.
 */
export const seenOf = (
  payload: Uint8Array,
  { expected, values }: { expected: IParcelFields; values: Map<string, string> }
): Record<string, unknown> => {
  const read = readParcel(payload);

  if (!('parcel' in read)) {
    return { bytes: hexadecimalOf(payload), refused: read.refused, reason: read.reason };
  }

  const { parcel } = read;
  const captures: [string, string][] = [];
  const bytesSeen = (
    name: 'acceptor' | 'incarnation' | 'opener',
    actual: Uint8Array | undefined
  ): unknown => {
    const want = expected[name];

    if (actual === undefined) {
      return undefined;
    }

    const hex = hexadecimalOf(actual);

    if (typeof want === 'object') {
      const isShaped =
        actual.length === SHAPE_BYTES[want.shape] &&
        (want.shape !== 'half' ||
          actual.some((byte) => {
            return byte !== 0;
          }));

      if (isShaped) {
        captures.push([want.capture, hex]);

        return want;
      }

      return hex;
    }

    return want !== undefined && hexadecimalOf(fromHexadecimal(filledOf(want, values))) === hex
      ? want
      : hex;
  };
  const { acceptor, carried, incarnation, layout: _layout, opener, ...rest } = parcel;
  const seen: Record<string, unknown> = {
    ...rest,
    acceptor: bytesSeen('acceptor', acceptor),
    opener: bytesSeen('opener', opener),
    ...(incarnation === undefined ? {} : { incarnation: bytesSeen('incarnation', incarnation) }),
  };

  if (carried !== undefined) {
    if (typeof expected.envelope === 'object') {
      seen['envelope'] = envelopeOf(carried, expected.envelope);
    } else if (expected.envelope !== undefined) {
      seen['envelope'] = hexadecimalOf(carried);
    } else {
      seen['part'] = hexadecimalOf(carried);
    }
  }

  for (const [name, hex] of captures) {
    if (!values.has(name)) {
      values.set(name, hex);
    }
  }

  return seen;
};

/** `expected` as `seenOf` shows a match: its envelope's and its part's bytes as the codec writes them. */
export const expectedSeenOf = (expected: IParcelFields): Record<string, unknown> => {
  const { envelope, part } = expected;

  return {
    ...expected,
    ...(typeof envelope === 'string' ? { envelope: hexadecimalOf(fromHexadecimal(envelope)) } : {}),
    ...(part === undefined ? {} : { part: hexadecimalOf(fromHexadecimal(part)) }),
  };
};

// definition

/**
 * The test's participants `ids` over `broker`, each started and its inbox subscribed, and in the
 * client role the server's name `interop` as well, alone, so that each reads every OPEN. `under` is
 * the id of the participant under test, whose inbox `inbox` names.
 */
export const createBrokerPeers = async (
  broker: IMemoryBroker,
  { ids, isClient, under }: { ids: readonly string[]; isClient: boolean; under: string }
): Promise<IBrokerPeers & AsyncDisposable> => {
  const peers = new Map<
    string,
    {
      adapter: IMemoryBrokerAdapter;
      heard: IHeardMessage[];
      waiting: (() => void)[];
    }
  >();

  for (const id of ids) {
    const adapter = broker.adapter({ id });
    const peer = { adapter, heard: [] as IHeardMessage[], waiting: [] as (() => void)[] };

    adapter.on('message', (message) => {
      const { payload, topic } = message;

      message.settle();
      peer.heard.push({ payload, topic });

      for (const wake of peer.waiting.splice(0)) {
        wake();
      }
    });
    await adapter.start();
    await adapter.subscribe([ROOT, 'i', id]);

    if (isClient) {
      await adapter.subscribe([ROOT, 's', 'interop']);
    }

    peers.set(id, peer);
  }

  const peerOf = (id: string) => {
    const peer = peers.get(id);

    if (peer === undefined) {
      throw new Error(`no peer ${id} in the case`);
    }

    return peer;
  };

  return {
    next: async (id, within) => {
      const peer = peerOf(id);

      if (peer.heard.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, within);

          peer.waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      return peer.heard.shift();
    },
    publish: (publication, values) => {
      const { from, publish, retained, to } = publication;
      const { adapter } = peerOf(from);
      const topic: BrokerTopic = {
        departure: [ROOT, 'd', from],
        inbox: [ROOT, 'i', under],
        name: [ROOT, 's', 'interop'],
      }[to];

      // * each published in this turn, in its order, none awaited before the next
      return Promise.all(
        publish.map((item) => {
          const payload =
            'parcel' in item
              ? parcelBytesOf(item.parcel, values)
              : fromHexadecimal(filledOf(item.bytes, values));

          return adapter.publish({ payload, retained: retained === true, topic });
        })
      );
    },
    [Symbol.asyncDispose]: async () => {
      for (const { adapter } of peers.values()) {
        await adapter.stop();
      }
    },
  };
};

export { BROKER_PUBLISHED };
