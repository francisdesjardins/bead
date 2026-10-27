// ── Broker peer ───────────────────────────────────────────────────────────────

// The test's own participants of a broker, in memory or over MQTT 5, as `spec/transports.json`
// plays them: each publishes the parcels a case writes by their fields and reads its inbox,
// answering nothing of its own.

// dependencies

import {
  type IExpected,
  expectedOf,
  failureDetailOf,
  hexadecimalOf,
} from '../../../router/server/__tests__/expected-envelope';
import { fromHexadecimal } from '../../../router/shared/__tests__/vectors';
import { encodeParcel, ParcelKind, readParcel } from '../../shared/broker-parcel';
import {
  BROKER_PUBLISHED,
  type BrokerPublished,
  type BrokerTopic,
  type IBrokerAdapter,
  type IMemoryBrokerPublication,
} from '../../shared/memory-broker';

// interfaces

/** A value of the side under test, kept under `capture` as it is first read, unlike one before. */
export interface ICaptured {
  capture: string;
  shape: 'half' | 'incarnation';
  unlike?: string;
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
  /** Has `id` let its inbox go, its unsubscription settled. */
  leave(id: string): Promise<void>;
  /**
   * The next message `id` is handed, or none within `within` milliseconds: on its inbox or the
   * server's name, or, `at` the departure, on the departure of the participant under test.
   */
  next(
    id: string,
    { at, within }: { at?: 'departure' | undefined; within: number }
  ): Promise<IHeardMessage | undefined>;
  /** Publishes `publication` in one turn, none awaited before the next; resolves with what the broker said. */
  publish(
    publication: IPublication,
    values: ReadonlyMap<string, string>
  ): Promise<BrokerPublished[]>;
}

// types

/** A peer's adapter, as a case's broker gives it: one of the in-memory broker marks retained. */
export type PeerAdapter = IBrokerAdapter & {
  publish(publication: IMemoryBrokerPublication): Promise<BrokerPublished>;
};

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
 * expected value, its `{name}` put in, or as the capture it matched in shape and unlike the one it
 * names, which `values` keeps; a field the parcel has that `expected` names none of shows as
 * itself, so the comparison fails.
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
          })) &&
        (want.unlike === undefined || values.get(want.unlike) !== hex);

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

/** The will a peer leaves where its case asks one: the GONE of its id and of `incarnation`. */
const willOf = (id: string, incarnation: string | undefined) => {
  return incarnation === undefined
    ? undefined
    : {
        payload: encodeParcel({
          acceptor: new Uint8Array(8),
          flags: 0,
          id,
          incarnation: fromHexadecimal(incarnation),
          kind: ParcelKind.GONE,
          opener: new Uint8Array(8),
          sequence: 0,
        }),
        topic: [ROOT, 'd', id],
      };
};

// definition

/**
 * The test's participants `ids`, each an adapter `adapterOf` resolves with, started, a will left where
 * `wills` names its incarnation, and its inbox subscribed; in the client role the server's name
 * `interop` as well, alone, so that each reads every OPEN, and the departure of the participant
 * under test, so that each reads its GONE. `under` is the id of the participant under test, whose
 * inbox `inbox` names.
 */
export const createBrokerPeers = async (
  adapterOf: (id: string) => Promise<PeerAdapter>,
  {
    ids,
    isClient,
    under,
    wills,
  }: {
    ids: readonly string[];
    isClient: boolean;
    under: string;
    wills?: ReadonlyMap<string, string> | undefined;
  }
): Promise<IBrokerPeers & AsyncDisposable> => {
  const peers = new Map<
    string,
    {
      adapter: PeerAdapter;
      departed: IHeardMessage[];
      heard: IHeardMessage[];
      waiting: (() => void)[];
    }
  >();
  const departure = [ROOT, 'd', under].join('/');
  const stopAll = async (): Promise<void> => {
    for (const { adapter } of peers.values()) {
      await adapter.stop();
    }
  };

  try {
    for (const id of ids) {
      const adapter = await adapterOf(id);
      const peer = {
        adapter,
        departed: [] as IHeardMessage[],
        heard: [] as IHeardMessage[],
        waiting: [] as (() => void)[],
      };

      adapter.on('message', (message) => {
        const { payload, topic } = message;

        message.settle();
        (topic.join('/') === departure ? peer.departed : peer.heard).push({ payload, topic });

        for (const wake of peer.waiting.splice(0)) {
          wake();
        }
      });
      peers.set(id, peer);
      await adapter.start({ will: willOf(id, wills?.get(id)) });
      await adapter.subscribe([ROOT, 'i', id]);

      if (isClient) {
        await adapter.subscribe([ROOT, 's', 'interop']);
        await adapter.subscribe([ROOT, 'd', under]);
      }
    }
  } catch (reason) {
    await stopAll();

    throw reason;
  }

  const peerOf = (id: string) => {
    const peer = peers.get(id);

    if (peer === undefined) {
      throw new Error(`no peer ${id} in the case`);
    }

    return peer;
  };

  return {
    leave: (id) => {
      return peerOf(id).adapter.unsubscribe([ROOT, 'i', id]);
    },
    next: async (id, { at, within }) => {
      const peer = peerOf(id);
      const queue = at === 'departure' ? peer.departed : peer.heard;
      const deadline = Date.now() + within;

      while (queue.length === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deadline - Date.now());

          peer.waiting.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      return queue.shift();
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
    [Symbol.asyncDispose]: stopAll,
  };
};

export { BROKER_PUBLISHED };
