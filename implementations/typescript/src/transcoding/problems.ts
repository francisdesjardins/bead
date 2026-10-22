// ── Problems ──────────────────────────────────────────────────────────────────

// What a gateway answers a failure with (spec/transcoding.md 7): a problem of RFC 9457 in section
// 17.7's canonical form, its status keyed by where its code arose, and `PAYLOAD_INVALID`'s
// violations as `errors`, each a `pointer` or a `parameter`.

// dependencies

import type { DescField, DescMessage } from '@bufbuild/protobuf';
import { FailureScope, ProtocolCode } from '../router/shared/constants';
import { PAYLOAD_CODECS } from '../router/shared/payloads';
import { type IViolation, violationsOf } from '../router/shared/violations';
import { fieldNamed, fragmentOf, pointerTokenOf, type RequestPlace } from './json-form';

// types

/**
 * Where a failure arose (7.5): its server answered it of the request; its client raised it before
 * the call went; its client raised it of a result or a notification; the gateway's own reading of
 * the request.
 */
export type Arose = 'answer' | 'client' | 'gateway' | 'server';

/** A failure of the gateway's own (7.6), each its status: `failed`, what no gate foresaw. */
export type OwnFailure = 'closed' | 'failed' | 'jwt' | 'scheme' | 'timeout' | 'unwritable';

/** A payload's encoding, as a binding names it. */
export type Encoding = 'json' | 'proto' | 'raw' | 'text';

// interfaces

/** A call's failure, as the gateway's client read it, and where it arose. */
export interface ICallFailure {
  readonly arose: Arose;
  readonly code: number;
  /** Whether its call presented a credential, which a 401 tells as `invalid_token`. */
  readonly credential?: boolean | undefined;
  readonly detail?: string | undefined;
  /** The encoding of the request its server could not read; `proto` where none is given. */
  readonly encoding?: Encoding | undefined;
  /** Where the gateway's reading met what it refuses, as 7.4 places one. */
  readonly place?: RequestPlace | undefined;
  readonly scope: 'application' | 'protocol';
}

/** Where a request's fields came from, so a violation says where its field lies (7.4). */
export interface IProblemRoute {
  /** `*`, a top-level field's proto name, or none where the route takes no body. */
  readonly body?: string | undefined;
  /** The request's message, which maps 18.4's proto names to JSON names. */
  readonly request: DescMessage;
  /** The field paths its variables bind, as its template writes them. */
  readonly variables: readonly string[];
}

/** What a problem is written with besides its failure. */
export interface IProblemOptions {
  /** The service's catalogue, each failure's code by its name. */
  readonly catalogue?: Readonly<Record<string, number>> | undefined;
  /** The gateway's challenge, `Bearer` by default. */
  readonly challenge?: string | undefined;
  /** The base of an application failure's type; none, `about:blank`. */
  readonly problemTypes?: string | undefined;
  /** Where its request's fields came from, for `PAYLOAD_INVALID`'s violations. */
  readonly route?: IProblemRoute | undefined;
}

/** A problem as a gateway answers it: its status, the fields beside it, and its body's text. */
export interface IProblem {
  readonly body: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly status: number;
}

// constants

/** The media type of a problem (RFC 9457 §3). */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** A protocol code's problem type is this, followed by its name, or its number (7.3). */
export const PROTOCOL_TYPES = 'tag:francisdesjardins.ca,2026:bead/';

/** The challenge a 401 carries where the gateway is given none (7.6). */
export const DEFAULT_CHALLENGE = 'Bearer';

const ABOUT_BLANK = 'about:blank';

/** The phrase RFC 9110 gives each status a gateway answers, an `about:blank` problem's title. */
export const STATUS_PHRASES: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

const CODE_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(ProtocolCode).map(([name, code]) => {
    return [code, name] as const;
  })
);

const OWN_STATUSES: Readonly<Record<OwnFailure, number>> = Object.freeze({
  closed: 502,
  failed: 500,
  jwt: 431,
  scheme: 401,
  timeout: 504,
  unwritable: 500,
});

const RETRY = Object.freeze({ 'retry-after': '1' });

// an element of 18.4's field path: its name, then its subscript where it has one
const ELEMENT =
  /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(-?[0-9]+|true|false|"(?:[^"\\]|\\.)*"(?:\.\.\.)?)\])?/u;

// helpers

/** A challenge with `error=` after it: after a space, or after `, ` where it holds parameters. */
const challengeOf = (challenge: string, error: string): string => {
  return `${challenge}${challenge.trim().includes(' ') ? ', ' : ' '}error="${error}"`;
};

/** A protocol code's status by where it arose, and the fields beside it (7.6). */
const protocolStatusOf = (
  failure: ICallFailure,
  challenge: string
): { fields: Record<string, string>; status: number } => {
  const { arose, code, credential = false, encoding = 'proto' } = failure;

  switch (code) {
    case ProtocolCode.ENVELOPE_MALFORMED:
      return { fields: {}, status: 500 };
    case ProtocolCode.LAYOUT_UNSUPPORTED:
    case ProtocolCode.KIND_UNSUPPORTED:
      return { fields: {}, status: 502 };
    case ProtocolCode.ENVELOPE_TOO_LARGE:
    case ProtocolCode.PAYLOAD_TOO_LARGE:
      return { fields: {}, status: arose === 'answer' ? 502 : 413 };
    case ProtocolCode.DESTINATION_UNREACHABLE:
      return { fields: { ...RETRY }, status: 503 };
    case ProtocolCode.SERVICE_UNKNOWN:
    case ProtocolCode.PROCEDURE_UNKNOWN:
      return { fields: {}, status: 501 };
    case ProtocolCode.SESSION_REQUIRED:
      return {
        fields: {
          'www-authenticate': credential ? challengeOf(challenge, 'invalid_token') : challenge,
        },
        status: 401,
      };
    case ProtocolCode.ACCESS_DENIED:
      return { fields: {}, status: 403 };
    case ProtocolCode.CAPACITY_EXCEEDED:
      return { fields: { ...RETRY }, status: 429 };
    case ProtocolCode.PAYLOAD_UNDECODABLE: {
      const isCallers =
        arose === 'gateway' || arose === 'client' || (arose === 'server' && encoding !== 'proto');

      return { fields: {}, status: isCallers ? 400 : 502 };
    }
    case ProtocolCode.TRANSFER_STALLED:
      return { fields: {}, status: 504 };
    case ProtocolCode.PAYLOAD_INVALID:
      return { fields: {}, status: 422 };
    case ProtocolCode.DESTINATION_LOST:
      return { fields: {}, status: 502 };
    default:
      return { fields: {}, status: 500 };
  }
};

/** An element of 18.4's field path: its name, and its subscript read, a cut key told apart. */
interface IElement {
  readonly name: string;
  readonly subscript?: { readonly isCut: boolean; readonly text: string } | undefined;
}

/** 18.4's field path read into its elements; none for one off its grammar. */
const elementsOf = (fieldPath: string): IElement[] | undefined => {
  const elements: IElement[] = [];
  let rest = fieldPath;

  for (;;) {
    const match = ELEMENT.exec(rest);

    if (match === null) {
      return undefined;
    }

    const [whole, name = '', subscript] = match;
    let read: IElement['subscript'];

    if (subscript?.startsWith('"') === true) {
      const isCut = subscript.endsWith('...');

      read = {
        isCut,
        text: JSON.parse(isCut ? subscript.slice(0, -3) : subscript) as string,
      };
    } else if (subscript !== undefined) {
      read = { isCut: false, text: subscript };
    }

    elements.push({ name, subscript: read });
    rest = rest.slice(whole.length);

    if (rest === '') {
      return elements;
    }

    if (!rest.startsWith('.')) {
      return undefined;
    }

    rest = rest.slice(1);
  }
};

/** The message a field holds, singular, repeated or a map's value; none for a scalar or an enum. */
const messageOf = (field: DescField): DescMessage | undefined => {
  if (field.fieldKind === 'message') {
    return field.message;
  }

  return (field.fieldKind === 'list' && field.listKind === 'message') ||
    (field.fieldKind === 'map' && field.mapKind === 'message')
    ? field.message
    : undefined;
};

/**
 * Where a violation's field lies (7.4): `parameter`, of a variable or the query; `pointer`, into
 * the body; or neither, for a rule of the message itself where the body is not the request whole,
 * and for a field path that names no field of the request.
 */
const placeOf = (violation: IViolation, route: IProblemRoute): RequestPlace | undefined => {
  const { fieldPath } = violation;
  const isWhole = route.body === '*';

  if (fieldPath === undefined) {
    return isWhole ? { pointer: '#' } : undefined;
  }

  const elements = elementsOf(fieldPath);

  if (elements === undefined) {
    return isWhole ? { pointer: '#' } : undefined;
  }

  const names = elements
    .map(({ name }) => {
      return name;
    })
    .join('.');

  if (route.variables.includes(names)) {
    return { parameter: names };
  }

  const [first] = elements;
  const inBody = isWhole || (route.body !== undefined && first?.name === route.body);

  // * each element's field, by its JSON name, a oneof's name standing for the message that holds it
  const tokens: string[] = [];
  const jsonNames: string[] = [];
  let message: DescMessage | undefined = route.request;

  for (const [index, element] of elements.entries()) {
    const field = message === undefined ? undefined : fieldNamed(message, element.name);

    if (field === undefined) {
      break;
    }

    jsonNames.push(field.jsonName);

    // the body a `body` field makes has that field as its root
    if (!(index === 0 && !isWhole)) {
      tokens.push(pointerTokenOf(field.jsonName));
    }

    const { subscript } = element;

    if (subscript?.isCut === true) {
      break;
    }

    if (subscript !== undefined) {
      tokens.push(pointerTokenOf(subscript.text));
    }

    message = messageOf(field);
  }

  if (!inBody) {
    return jsonNames.length === 0 ? undefined : { parameter: jsonNames.join('.') };
  }

  return {
    pointer: `#${tokens
      .map((token) => {
        return `/${fragmentOf(token)}`;
      })
      .join('')}`,
  };
};

/** `PAYLOAD_INVALID`'s members: its violations as `errors`, its closing line's `more` or `stopped`. */
const invalidMembersOf = (
  failure: ICallFailure,
  route: IProblemRoute | undefined
): Record<string, unknown> => {
  const { more, stopped, violations } = violationsOf({
    code: failure.code,
    detail: failure.detail,
    scope: FailureScope.PROTOCOL,
  });

  return {
    errors: violations.map((violation) => {
      const { bounds, fieldPath, forKey, message, ruleId } = violation;

      return {
        ...(bounds === undefined ? {} : { bounds }),
        ...(message === undefined ? {} : { detail: message }),
        ...(fieldPath === undefined ? {} : { fieldPath }),
        ...(forKey === undefined ? {} : { forKey }),
        ruleId,
        ...(route === undefined ? {} : placeOf(violation, route)),
      };
    }),
    ...(more === undefined || more === 0 ? {} : { more }),
    ...(stopped === undefined ? {} : { stopped }),
  };
};

/** A problem's text, its members in section 17.7's canonical form (7.2). */
const textOf = (members: Record<string, unknown>): string => {
  return new TextDecoder().decode(PAYLOAD_CODECS.json.encode(members));
};

// definition

/**
 * The problem a gateway answers a call's failure with (transcoding 7): its status by its code and
 * where it arose, the fields beside it — `retry-after`, a 401's `www-authenticate` — and its body,
 * `type`, `title`, `status`, `detail`, `code` and `scope`, and for `PAYLOAD_INVALID` its violations
 * as `errors`, each its `pointer` or its `parameter` where `options.route` says where its request's
 * fields came from.
 */
export const problemOfFailure = (
  failure: ICallFailure,
  options: IProblemOptions = {}
): IProblem => {
  const { catalogue = {}, challenge = DEFAULT_CHALLENGE, problemTypes, route } = options;
  const { code, detail = '', scope } = failure;

  if (scope === 'application') {
    const name = Object.entries(catalogue).find(([, value]) => {
      return value === code;
    })?.[0];
    const identity = name ?? String(code);

    return {
      body: textOf({
        code,
        ...(detail === '' ? {} : { detail }),
        scope,
        status: 400,
        title: problemTypes === undefined ? STATUS_PHRASES[400] : identity,
        type: problemTypes === undefined ? ABOUT_BLANK : `${problemTypes}${identity}`,
      }),
      fields: {},
      status: 400,
    };
  }

  const { fields, status } = protocolStatusOf(failure, challenge);
  const identity = CODE_NAMES.get(code) ?? String(code);
  const isInvalid = code === ProtocolCode.PAYLOAD_INVALID;
  // * the gateway's own error between it and its server: its code alone (spec 9.0)
  const isCodeAlone = isInvalid || code === ProtocolCode.DESTINATION_UNREACHABLE;

  return {
    body: textOf({
      code,
      ...(detail === '' || isCodeAlone ? {} : { detail }),
      ...(isInvalid ? invalidMembersOf(failure, route) : {}),
      ...(failure.arose === 'gateway' ? failure.place : {}),
      scope,
      status,
      title: identity,
      type: `${PROTOCOL_TYPES}${identity}`,
    }),
    fields,
    status,
  };
};

/**
 * The problem of a failure of the gateway's own (7.6) — its call's timeout, 504; its connection
 * closed, 502; a result it cannot write, 500; a `JWT` its block cannot hold, 431; an auth-scheme
 * but `Bearer` under `bearer-jwt`, 401; what no gate foresaw, 500 — `about:blank`, its detail its
 * words, none for what no gate foresaw.
 */
export const problemOfOwn = (
  own: OwnFailure,
  { challenge = DEFAULT_CHALLENGE, detail }: { challenge?: string | undefined; detail: string }
): IProblem => {
  const status = OWN_STATUSES[own];

  return {
    ...problemOfRefusal(status, detail),
    fields:
      own === 'scheme' ? { 'www-authenticate': challengeOf(challenge, 'invalid_request') } : {},
  };
};

/**
 * The problem of a refusal of the gateway's own (7.7), `about:blank`, its title its status's
 * phrase, its detail its words.
 */
export const problemOfRefusal = (status: number, detail: string): IProblem => {
  return {
    body: textOf({
      ...(detail === '' ? {} : { detail }),
      status,
      title: STATUS_PHRASES[status] ?? String(status),
      type: ABOUT_BLANK,
    }),
    fields: {},
    status,
  };
};
