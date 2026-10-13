// ── What the panel copies ─────────────────────────────────────────────────────

// What Copy as code and Copy as conversation write. The first is a snippet to paste into the
// page's console, which makes a call again by the page's own service manager, its payload whole:
// the panel never calls itself (decision 0015). The second is the skeleton of an entry of
// `spec/conversations.json`, from the bytes an HTTP exchange carried, for whoever writes the next
// one: what went out, in hexadecimal as `spec/vectors.json` writes it, and each envelope that came
// back, as a conversation expects it.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import type { IWireEnvelope } from '../wire';
import type { ICall } from './calls';
import {
  destinationOf,
  type IPayload,
  presentedOf,
  requestPayloadOf,
  startOf,
  subscriptionOf,
} from './facts';
import { codeOfTree } from './tree';
import { clockOf, schemeNameOf } from './words';

// helpers

/** Bytes in hexadecimal, upper case, a space between two. */
const hexOf = (bytes: Uint8Array): string => {
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0').toUpperCase();
    })
    .join(' ');
};

/**
 * An envelope as a conversation sends it: its header, its first two groups of four bytes apart,
 * then, after a bar, what follows it.
 */
const sendOf = ({ bytes, headerBytes }: IWireEnvelope): string => {
  const header = [bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8, headerBytes)]
    .filter((group) => {
      return group.length > 0;
    })
    .map(hexOf)
    .join('  ');
  const rest = bytes.subarray(headerBytes);

  return rest.length === 0 ? header : `${header} | ${hexOf(rest)}`;
};

/** An envelope as a conversation expects it: its kind, its call, and what its kind carries. */
const expectOf = ({
  bytes,
  failure,
  header,
  headerBytes,
}: IWireEnvelope): Record<string, unknown> => {
  const kind = Number(header['kind']);
  const expected: Record<string, unknown> = { kind, callId: header['callId'] };
  const scheme = header['credentialScheme'];

  if (kind === EnvelopeKind.REQUEST) {
    expected['flags'] = bytes[2] ?? 0;
    expected['serviceId'] = header['serviceId'];
    expected['procedureId'] = header['procedureId'];
  }

  if (failure === undefined && kind !== EnvelopeKind.CREDIT && kind !== EnvelopeKind.CANCEL) {
    expected['payload'] = hexOf(bytes.subarray(headerBytes));
  }

  if (failure !== undefined) {
    expected['failure'] = {
      code: failure.code,
      scope: failure.scope,
      relays: failure.relays,
      ...(failure.detail === '' ? {} : { detail: failure.detail }),
    };
  }

  for (const name of ['total', 'offset', 'isLast', 'creditEnd'] as const) {
    if (header[name] !== undefined) {
      expected[name] = header[name];
    }
  }

  if (kind === EnvelopeKind.CREDIT) {
    expected['paced'] = header['paced'] === true;
  }

  if (typeof scheme === 'number' && kind !== EnvelopeKind.REQUEST) {
    expected['credential'] = schemeNameOf(scheme);
  }

  return expected;
};

/**
 * A payload as JavaScript: its tree's, where the hook sent one; else its text, as JSON where it reads
 * as JSON and as a string where not; none for a payload cut short.
 */
const valueCodeOf = (payload: IPayload | undefined): string | undefined => {
  if (payload === undefined) {
    return 'undefined';
  }

  if (payload.tree !== undefined) {
    return codeOfTree(payload.tree);
  }

  if (payload.text.endsWith('…')) {
    return undefined;
  }

  try {
    JSON.parse(payload.text);

    return payload.text;
  } catch {
    return JSON.stringify(payload.text);
  }
};

// definition

/**
 * A snippet that makes `call` again by the page's own service manager, for its console: none for a
 * call the server made, or whose payload the preview cut short.
 */
export const codeOfCall = (call: ICall): string | undefined => {
  const value = valueCodeOf(requestPayloadOf(call));

  if (
    call.isIncoming ||
    call.isNotification ||
    value === undefined ||
    call.procedureName === undefined
  ) {
    return undefined;
  }

  const procedure = `{ procedureId: ${String(call.procedureId)}, procedureName: ${JSON.stringify(call.procedureName)}, serviceId: ${String(call.serviceId)}, serviceRevision: ${String(call.serviceRevision ?? 1)} }`;
  const timeout = call.opening?.timeout;
  const destination = destinationOf(call);
  const scheme = presentedOf(call);
  const options = [
    ...(timeout === undefined
      ? []
      : [`timeout: ${timeout === 'never' ? 'Infinity' : String(timeout)}`]),
    ...(destination === undefined ? [] : [`destinationId: ${String(destination)}`]),
    ...(call.opening?.closeOnTimeout === true ? ['closeOnTimeout: true'] : []),
  ];
  const head = [
    `// ${call.procedureName}${call.callId === undefined ? '' : `, call #${String(call.callId)}`}, as client ${String(call.source)} made it at ${clockOf(startOf(call))}`,
    '// `services` is the page’s service manager and `serializer` the procedure’s own, as the page has them',
    ...(scheme === undefined
      ? []
      : [
          `// it presented a credential, ${schemeNameOf(scheme)}: give it as the page does, as \`credential\``,
        ]),
  ];

  if (subscriptionOf(call) !== undefined) {
    return [
      ...head,
      `const registrar = services.getNotification(${procedure}, { serializer })(${value}, (notification) => {`,
      '  console.log(notification);',
      '});',
    ].join('\n');
  }

  return [
    ...head,
    `await services.getRequest(${procedure}, { serializer })(${value})({ ${options.join(', ')} });`,
  ].join('\n');
};

/**
 * The skeleton of an entry of `spec/conversations.json`, as text: what the request sent, and each
 * envelope its answer or a listen brought back.
 */
export const conversationOf = ({
  request,
  response,
}: {
  request: readonly IWireEnvelope[];
  response: readonly IWireEnvelope[];
}): string => {
  return JSON.stringify(
    {
      name: 'what the server does: say it in a sentence',
      clauses: [],
      steps: [
        ...request.map((envelope) => {
          return { send: sendOf(envelope) };
        }),
        ...response.map((envelope) => {
          return { expect: expectOf(envelope) };
        }),
      ],
    },
    null,
    2
  );
};
