// dependencies

import {
  type IParcel,
  type IParcelPrefix,
  hexOfByte,
  kindNamed,
  ParcelFlag,
  ParcelKind,
} from './broker-parcel';
import type { BrokerTopic, IGauges } from './types';

// constants

/** What the participant decides about an incoming message (debugging 13). */
export const PARCEL_VERDICTS = Object.freeze({
  ADVISORY: 'advisory',
  COPY: 'copy',
  DOES_NOT_READ: 'does-not-read',
  LOSS: 'loss',
  NO_PARCEL: 'no-parcel',
  OFF_TOPIC: 'off-topic',
  PAIR_NOT_HELD: 'pair-not-held',
  RETAINED: 'retained',
  TAKEN: 'taken',
} as const);

export type ParcelVerdict = (typeof PARCEL_VERDICTS)[keyof typeof PARCEL_VERDICTS];

// interfaces

/** A participant's levels, read by pull while a tool shows them. */
export interface IParticipantInspection {
  readonly id: string;
  readonly inbox: BrokerTopic;
  readonly incarnation: string | undefined;
  readonly isLinked: boolean;
  readonly names: readonly string[];
  readonly gauges: Pick<IGauges, 'counts' | 'ceilings' | 'anomalies'>;
}

/** A participant's trace, without carried bytes, credentials or an acceptor's half. */
export interface IParticipantDebugEvent {
  readonly event: 'parcel' | 'link' | 'names' | 'report';
  readonly direction?: 'rx' | 'tx' | undefined;
  readonly topic?: BrokerTopic | undefined;
  readonly bytes?: number | undefined;
  readonly layout?: number | undefined;
  readonly kind?: string | undefined;
  readonly flags?: number | undefined;
  readonly sequence?: number | undefined;
  readonly opener?: string | undefined;
  readonly connection?: number | undefined;
  readonly connectionHandle?: string | undefined;
  readonly id?: string | undefined;
  readonly incarnation?: string | undefined;
  readonly bound?: number | undefined;
  readonly secure?: boolean | undefined;
  readonly status?: number | undefined;
  readonly carriedBytes?: number | undefined;
  readonly more?: boolean | undefined;
  readonly hasCredential?: boolean | undefined;
  readonly answers?: number | undefined;
  readonly code?: number | undefined;
  readonly verdict?: ParcelVerdict | undefined;
  readonly awaited?: number | undefined;
  readonly came?: number | undefined;
  readonly state?: 'up' | 'down' | 'taken-over' | 'stopped' | undefined;
  readonly ended?: readonly number[] | undefined;
  readonly name?: string | undefined;
  readonly isHeld?: boolean | undefined;
  readonly group?: string | undefined;
  readonly report?: string | undefined;
}

// helpers

/** Hexadecimal metadata, read only while watched. @internal */
export const participantHexOf = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => {
    return byte.toString(16).padStart(2, '0');
  }).join('');
};

/** The allowlist of a parcel's fields, from the participant's own reading. @internal */
export const participantParcelOf = (parcel: IParcelPrefix): Partial<IParticipantDebugEvent> => {
  const body = parcel as IParcel;
  const fields: Partial<IParticipantDebugEvent> = {
    flags: body.flags,
    kind:
      parcel.kind >= 0x80
        ? `advisory ${parcel.kind}`
        : parcel.kind > ParcelKind.GONE
          ? hexOfByte(parcel.kind)
          : kindNamed(parcel.kind).replace(/^an? /u, ''),
    layout: parcel.layout,
    opener: participantHexOf(parcel.opener),
    sequence: parcel.sequence,
  };

  switch (parcel.kind) {
    case ParcelKind.OPEN:
    case ParcelKind.ACCEPT:
      return {
        ...fields,
        bound: body.bound,
        id: body.id,
        incarnation:
          body.incarnation === undefined ? undefined : participantHexOf(body.incarnation),
        secure: body.flags === undefined ? undefined : (body.flags & ParcelFlag.SECURE) !== 0,
      };
    case ParcelKind.REFUSE:
      return { ...fields, status: body.status };
    case ParcelKind.DATA:
      return {
        ...fields,
        carriedBytes: body.carried?.length,
        hasCredential:
          body.flags === undefined ? undefined : (body.flags & ParcelFlag.CREDENTIAL) !== 0,
        more: body.flags === undefined ? undefined : (body.flags & ParcelFlag.MORE) !== 0,
      };
    case ParcelKind.PONG:
      return { ...fields, answers: body.answers };
    case ParcelKind.CLOSE:
      return { ...fields, code: body.code };
    case ParcelKind.GONE:
      return {
        ...fields,
        id: body.id,
        incarnation:
          body.incarnation === undefined ? undefined : participantHexOf(body.incarnation),
      };
    default:
      return fields;
  }
};
