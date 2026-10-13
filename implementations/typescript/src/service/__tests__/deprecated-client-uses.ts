// ── The client side's uses of what is deprecated ─────────────────────────────

// Each member the client side maps from a descriptor, used by a deprecated name and by its
// replacement's. A use the lint must flag carries the directive that silences it, and
// `deprecationsIn` lints the file apart, every directive bound to be used. Never run.

// dependencies

import type { IClient } from '../../client/types';
import { createServiceClient, type IServiceClientOptions } from '../service-client';
import { ArchiveProcedures } from './fixtures';

// constants

/** A window of each procedure that notifies, by its key. */
export const ARCHIVE_WINDOWS: IServiceClientOptions<typeof ArchiveProcedures>['windows'] = {
  follow: 4,
  // oxlint-disable-next-line typescript/no-deprecated -- a window's key, mapped from a deprecated descriptor
  watch: 4,
};

// definition

/** Each requester and notification of the archive's client side, by its name. */
export const clientSideUses = (client: IClient): readonly unknown[] => {
  const archive = createServiceClient(ArchiveProcedures, client, { windows: ARCHIVE_WINDOWS });

  return [
    archive.request.fetch,
    // oxlint-disable-next-line typescript/no-deprecated -- a requester, mapped from a deprecated descriptor
    archive.request.fetchAll,
    archive.request.follow,
    // oxlint-disable-next-line typescript/no-deprecated -- a requester of one that notifies, mapped alike
    archive.request.watch,
    archive.notifications.follow,
    // oxlint-disable-next-line typescript/no-deprecated -- a notification, mapped from a deprecated descriptor
    archive.notifications.watch,
  ];
};
