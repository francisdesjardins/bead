// ── A consumer of the split output ────────────────────────────────────────────

// Each use a consumer makes of the goldens' split output (decision 0048): its server class holds
// the procedures it serves and refuses any other's resolver; its client class holds the procedures
// it calls and no other's requester; `SERVED_PROCEDURES` gives a transport its option. Never run;
// `yarn type-check` compiles it, each `@ts-expect-error` an error the build would report, and the
// target's test "a server class refuses a resolver of a procedure it does not serve" compiles it
// again without its first. The C# side refuses such a resolver as it is registered, in
// `Bead.Goldens.Tests`.

// dependencies

import { SERVED_PROCEDURES } from '../golden/typescript/subsets/bead_served.ts';
import { ShopClient, ShopServer } from '../golden/typescript/subsets/shop_bead.ts';

// types

declare const beadClient: ConstructorParameters<typeof ShopClient>[0];

// definition

/** The server's uses: a resolver of a procedure it serves, and of one it does not. */
export const serverUses = (): readonly unknown[] => {
  // * no hook named: audit's, auditor, is a procedure called here, not served
  const server = new ShopServer();

  server.on('placeOrder', async (request, response) => {
    await response(request.payload);
  });
  // @ts-expect-error listOrders is called here, not served
  server.on('listOrders', async (request, response) => {
    await response(request.payload);
  });

  return [server.notify.watchOrders, server.command.refreshCatalogue];
};

/** The client's uses: a requester of a procedure it calls, and of one it does not. */
export const clientUses = (): readonly unknown[] => {
  const client = new ShopClient(beadClient);

  return [
    client.listOrders,
    client.audit,
    client.notifications.watchOrders,
    // @ts-expect-error placeOrder is served here, not called
    client.placeOrder,
  ];
};

/** What each transport takes, its option `procedures`. */
export const transports: readonly (readonly { serviceId: number; procedureId: number }[])[] = [
  SERVED_PROCEDURES.webSocket,
  SERVED_PROCEDURES.orders,
  SERVED_PROCEDURES.none,
];
