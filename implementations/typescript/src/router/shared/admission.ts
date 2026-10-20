// ── Admission ─────────────────────────────────────────────────────────────────

// dependencies

import { handedHeaderOf } from './call-session';
import { FailureScope } from './constants';
import type {
  AdmissionFailure,
  IAdmissionRequest,
  IBeforeRequest,
  IFailure,
  IRouterFailures,
} from './types';

// constants

// the admissions this package gives, by the name an access refused tells (spec 13.12); an
// application's own is none of them
const NAMED_ADMISSIONS = new WeakMap<object, string>();

// the name of the admission of this package's that refused a request, by the very header it was
// asked on
const REFUSED_BY = new WeakMap<object, string>();

// helpers

/** `admission`, named `name` as one this package gives, which an access it refuses tells. */
export const namedAdmissionOf = <Admission extends object>(
  name: string,
  admission: Admission
): Admission => {
  NAMED_ADMISSIONS.set(admission, name);

  return admission;
};

/** Says that the admission this package gives named `name` refused the request of `header`. */
export const refusedBy = (header: object, name: string): void => {
  REFUSED_BY.set(header, name);
};

/**
 * The name of the admission this package gives that refused the request of `header`; none when
 * an application's own did.
 */
export const admissionNameOf = (header: object): string | undefined => {
  return REFUSED_BY.get(header);
};

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
 * The admission `beforeRequest` makes of a request, on its connection, its header and its call's
 * session alone, never a bearer credential its call came with: a `JWT` its header presents says its
 * scheme alone (spec 13.1). `undefined` admits it, and only `true` does — a composition that loses
 * its refusal, or a caller without types that returns nothing or a failure, is refused all the same,
 * with its `refusal` as it is, or `failures`' access denied. Its router answers a SESSION_REQUIRED
 * of a call whose header presents a credential ACCESS_DENIED, as it does every handler's (spec 9.2,
 * step 6). A `beforeRequest` that throws throws.
 */
export const admissionOf = <Handle extends string>(
  beforeRequest: IBeforeRequest<Handle>,
  failures: IRouterFailures
): ((request: IAdmissionRequest<Handle>) => AdmissionFailure | undefined) => {
  return ({ connectionHandle, header, session }) => {
    const admission: unknown = beforeRequest({
      connectionHandle,
      header: handedHeaderOf(header),
      session,
    });

    if (admission === true) {
      return undefined;
    }

    const name = NAMED_ADMISSIONS.get(beforeRequest);

    if (name !== undefined) {
      refusedBy(header, name);
    }

    return beforeRequest.refusal ?? failures.accessDenied;
  };
};
