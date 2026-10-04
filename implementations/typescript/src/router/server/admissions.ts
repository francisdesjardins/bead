// ── Admissions ────────────────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { CredentialScheme, SERVER_FAILURES } from '../shared/constants';
import type { IAdmissionRequest } from '../shared/types';

// definition

/**
 * A `beforeRequest`, or a relay's `beforeRoute`, that lets through only a call with a session, its
 * call's, never its connection's (spec 13.5): what every procedure but the one that makes the
 * session asks for. A relay given it refuses every credential it forwards without verifying, which
 * resolves to no session there. It refuses with its `refusal`, SESSION_REQUIRED. A composition by
 * `&&` loses that refusal and answers ACCESS_DENIED; a caller that wants to keep SESSION_REQUIRED
 * puts `refusal` on its own function.
 */
export const requireSession = Object.freeze(
  Object.assign(
    ({ session }: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'session'>): boolean => {
      return session !== undefined;
    },
    { refusal: SERVER_FAILURES.sessionRequired }
  )
);

/**
 * A server's relay's admission by default (spec 14.3, step 1): a call in leg A's connection's
 * session, or one whose header presents a `JWT`, or an `ELSEWHERE` its transport carried — read from
 * its credential scheme alone, since one that carried nothing never reaches an admission — which the
 * relay forwards, for its destination to verify. Any other is refused with its `refusal`,
 * SESSION_REQUIRED.
 */
export const requireSessionOrCredential = Object.freeze(
  Object.assign(
    ({
      header,
      session,
    }: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'header' | 'session'>): boolean => {
      const scheme = header.credential?.scheme;

      return (
        session !== undefined ||
        scheme === CredentialScheme.JWT ||
        scheme === CredentialScheme.ELSEWHERE
      );
    },
    { refusal: SERVER_FAILURES.sessionRequired }
  )
);
