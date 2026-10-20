// ── Admissions ────────────────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { namedAdmissionOf } from '../shared/admission';
import { CredentialScheme, SERVER_FAILURES } from '../shared/constants';
import type { IAdmissionRequest } from '../shared/types';

// definition

/**
 * A `beforeRequest`, or a relay's `beforeRoute`, that lets through only a call with a session, its
 * call's, never its connection's (spec 13.5): what every procedure but the one that makes the
 * session asks for. It refuses with its `refusal`, SESSION_REQUIRED, which its router answers a
 * call that presented a credential with ACCESS_DENIED (spec 9.2, step 6): a relay given it so
 * refuses every credential it forwards without verifying, which resolves to no session there, and a
 * call in none that presented none with SESSION_REQUIRED. A composition by `&&` loses that refusal
 * and answers ACCESS_DENIED; a caller that wants to keep SESSION_REQUIRED puts `refusal` on its own
 * function.
 */
export const requireSession = namedAdmissionOf(
  'requireSession',
  Object.freeze(
    Object.assign(
      ({
        session,
      }: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'session'>): boolean => {
        return session !== undefined;
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    )
  )
);

/**
 * A server's relay's admission by default (spec 14.3, step 1): a call whose header presents a `JWT`,
 * or an `ELSEWHERE` its transport carried, which the relay forwards for its destination to verify —
 * read from its credential scheme alone, unless the relay `verifies`, since one that carried
 * nothing never reaches an admission. Any other, one that presents none or `OPAQUE`, in leg A's
 * connection's session or in none, is refused with its `refusal`, ACCESS_DENIED, its detail naming
 * the default: leg A's session opens nothing at the destination, and a relay that lent leg B's
 * session to it would lend its own authority (spec 14.7).
 */
export const requireCredential = namedAdmissionOf(
  'requireCredential',
  Object.freeze(
    Object.assign(
      ({ header }: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'header'>): boolean => {
        const scheme = header.credential?.scheme;

        return scheme === CredentialScheme.JWT || scheme === CredentialScheme.ELSEWHERE;
      },
      {
        refusal: Object.freeze({
          ...SERVER_FAILURES.accessDenied,
          detail: 'a relay admits by default only a credential it forwards',
        }),
      }
    )
  )
);

/**
 * A relay's `beforeRoute` that lends leg B's session to every session of leg A's, at every
 * destination (spec 14.3, step 1): a call in leg A's connection's session, or one whose header
 * presents a `JWT`, or an `ELSEWHERE` its transport carried, read from its credential scheme alone.
 * It reads no destination; a `beforeRoute` that checks the destination against the session is the
 * one to write. Any other, a call in none that presented none, is refused with its `refusal`,
 * SESSION_REQUIRED.
 */
export const shareLegBSession = namedAdmissionOf(
  'shareLegBSession',
  Object.freeze(
    Object.assign(
      ({
        header,
        session,
      }: Pick<
        IAdmissionRequest<TransportServerConnectionHandle>,
        'header' | 'session'
      >): boolean => {
        return session !== undefined || requireCredential({ header });
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    )
  )
);
