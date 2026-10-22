// ── Demo over HTTP ───────────────────────────────────────────────────────────

// The sign-up as a gateway takes and answers it over HTTP and JSON (decision 0037): its request a
// `curl` of its default route, `POST /api/SignUp/signUp`, its body in Bead's JSON form; its answer
// the gateway's, a 200 of its result in that form, or a refusal in RFC 9457's problem, a
// PAYLOAD_INVALID's violations as `errors`, each placed by its pointer. Written by the runtime's own
// mapping and problems, as the internal demo's gateway writes them, so a page with no gateway of its
// own, its server a Web Worker, shows what one would answer.

// dependencies

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { FailureScope } from '../src/router/shared/constants';
import type { FailureError } from '../src/router/shared/errors';
import { problemOfFailure } from '../src/transcoding/problems';
import { typeRegistryOf, writeProtoJson } from '../src/transcoding/json-form';
import { SignUpRequestSchema, SignUpResponseSchema } from './gen/typescript/demo/v1/sign_up_pb';

// constants

/** The sign-up's default route, as beadc's table writes it. */
const ROUTE = '/api/SignUp/signUp';

/** Where the internal demo, `yarn demo`, serves it: the page names its own origin where it can. */
const DEMO_ORIGIN = 'http://localhost:8080';

const REGISTRY = typeRegistryOf([SignUpRequestSchema, SignUpResponseSchema]);

/** The reason phrases of the statuses the sign-up answers, RFC 9110's. */
const PHRASES: Readonly<Record<number, string>> = Object.freeze({
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

// helpers

/** A JSON text indented for reading: the gateway writes it on one line. */
const indented = (text: string): string => {
  return JSON.stringify(JSON.parse(text), null, 2);
};

const headOf = (status: number, type: string): string => {
  return `HTTP/1.1 ${String(status)} ${PHRASES[status] ?? ''}\ncontent-type: ${type}`;
};

// definition

/** The `curl` that sends `request` to the gateway, its body in Bead's JSON form. */
export const curlOf = (
  request: MessageInitShape<typeof SignUpRequestSchema>,
  { origin }: { origin?: string | undefined } = {}
): string => {
  const body = writeProtoJson(SignUpRequestSchema, {
    message: create(SignUpRequestSchema, request),
    registry: REGISTRY,
  });

  return [
    `curl -X POST ${origin ?? DEMO_ORIGIN}${ROUTE} \\`,
    "  -H 'content-type: application/json' \\",
    `  -d '${body.replaceAll("'", "'\\''")}'`,
  ].join('\n');
};

/** What the gateway answers a sign-up its server welcomed: a 200 of its result. */
export const welcomedOf = (welcome: string): string => {
  const body = writeProtoJson(SignUpResponseSchema, {
    message: create(SignUpResponseSchema, { welcome }),
    registry: REGISTRY,
  });

  return `${headOf(200, 'application/json')}\n\n${indented(body)}`;
};

/** What the gateway answers a sign-up its server refused: the failure's problem (RFC 9457). */
export const refusedOf = (failure: FailureError): string => {
  const problem = problemOfFailure(
    {
      arose: 'server',
      code: failure.code,
      detail: failure.detail,
      scope: failure.scope === FailureScope.APPLICATION ? 'application' : 'protocol',
    },
    // * the default route's body is the request whole: each violation's pointer from its root
    { route: { body: '*', request: SignUpRequestSchema, variables: [] } }
  );

  return `${headOf(problem.status, 'application/problem+json')}\n\n${indented(problem.body)}`;
};
