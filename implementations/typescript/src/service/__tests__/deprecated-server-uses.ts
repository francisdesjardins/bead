// ── The server side's uses of what is deprecated ─────────────────────────────

// Each member the server side maps from a descriptor, used by a deprecated name and by its
// replacement's. A use the lint must flag carries the directive that silences it, and
// `deprecationsIn` lints the file apart, every directive bound to be used. Never run.

// dependencies

import { createServiceServer, type ServiceResolvers } from '../service-server';
import { ArchiveProcedures } from './fixtures';

// constants

/** A resolver of each procedure the server answers, by its key. */
export const ARCHIVE_RESOLVERS: ServiceResolvers<typeof ArchiveProcedures> = {
  fetch: (request, response) => {
    return response(request.payload);
  },
  // oxlint-disable-next-line typescript/no-deprecated -- a resolver's key, mapped from a deprecated descriptor
  fetchAll: (request, response) => {
    return response(request.payload);
  },
  follow: (request, response) => {
    return response(request.payload);
  },
  // oxlint-disable-next-line typescript/no-deprecated -- a resolver's key, of one that notifies
  watch: (request, response) => {
    return response(request.payload);
  },
};

// definition

/** Each command's requester and notifier of the archive's server side, by its name. */
export const serverSideUses = (): readonly unknown[] => {
  const archive = createServiceServer(ArchiveProcedures);

  return [
    archive.command.ping,
    // oxlint-disable-next-line typescript/no-deprecated -- a command's requester, mapped from a deprecated descriptor
    archive.command.poke,
    archive.notify.follow,
    // oxlint-disable-next-line typescript/no-deprecated -- a notifier, mapped from a deprecated descriptor
    archive.notify.watch,
  ];
};
