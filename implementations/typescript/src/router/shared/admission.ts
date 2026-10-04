// ── Admission ─────────────────────────────────────────────────────────────────

// dependencies

import { FailureScope } from './constants';
import type {
  AdmissionFailure,
  IAdmissionRequest,
  IBeforeRequest,
  IFailure,
  IRouterFailures,
} from './types';

// definition

/** Whether `failure` refuses admission: one of the two of `failures`' table, of its own side. */
export const isAdmissionFailure = (failure: unknown, failures: IRouterFailures): boolean => {
  if (typeof failure !== 'object' || failure === null) {
    return false;
  }

  const { code, scope, side } = failure as Partial<IFailure & { side: unknown }>;

  return (
    scope === FailureScope.PROTOCOL &&
    (code === failures.sessionRequired.code || code === failures.accessDenied.code) &&
    side === failures.side
  );
};

/**
 * The admission `beforeRequest` makes of a request, on its header and its call's session alone:
 * `undefined` admits it, and only `true` does — a composition that loses its refusal, or a caller
 * without types that returns nothing or a failure, is refused all the same, with its `refusal`, or
 * `failures`' access denied. A refusal SESSION_REQUIRED of a call whose header presents a credential
 * goes out ACCESS_DENIED, its detail kept (spec 9.2, step 5). A `beforeRequest` that throws throws.
 */
export const admissionOf = <Handle extends string>(
  beforeRequest: IBeforeRequest<Handle>,
  failures: IRouterFailures
): ((request: IAdmissionRequest<Handle>) => AdmissionFailure | undefined) => {
  return ({ connectionHandle, header, session }) => {
    const admission: unknown = beforeRequest({ connectionHandle, header, session });

    if (admission === true) {
      return undefined;
    }

    const refusal = beforeRequest.refusal ?? failures.accessDenied;

    // ! never SESSION_REQUIRED to a call that presented a credential: the credential may hold, and
    // its requester would withdraw it
    if (refusal.code !== failures.sessionRequired.code || header.credential === undefined) {
      return refusal;
    }

    return refusal.detail === undefined
      ? failures.accessDenied
      : { ...failures.accessDenied, detail: refusal.detail };
  };
};
