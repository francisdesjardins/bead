// ── Transferable ──────────────────────────────────────────────────────────────

// dependencies

import type { Data } from './types';

// definition

/**
 * The bytes of `data` in a buffer of their own, for a port to transfer: a copy, since transferring a
 * buffer takes it from whoever else holds it — a view on a pool, the caller. `undefined` for what is
 * no bytes.
 */
export const transferableOf = (data: Data): ArrayBuffer | undefined => {
  if (data instanceof ArrayBuffer) {
    return data.slice(0);
  }

  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
    : undefined;
};
