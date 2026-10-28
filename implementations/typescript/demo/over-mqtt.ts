// ── Demo over MQTT 5 ──────────────────────────────────────────────────────────

// The demo over a broker of MQTT 5 (spec 15.25 to 15.31), where it runs beside one
// (`node tools/mqtt-broker.mjs run -- yarn demo`): its server a participant of the run's broker
// serving the name `demo`, and the page's client a participant of its own, over the broker's
// WebSocket. Both ids are users of the broker `tools/mqtt-broker.mjs` starts, its password drawn for
// the run; one page links at a time, since a second link of the client's id takes the first over.
// The page loads this module apart, so that a page served as files alone carries no MQTT library.

// dependencies

import { createClient } from '../src/client/client';
import type { IClient } from '../src/client/types';
import type { IMetricsRegistry } from '../src/router/shared/metrics-registry';
import type { RouterLimitsOptions } from '../src/router/shared/types';
import { createServer } from '../src/server/server';
import type { IServerOptions } from '../src/server/types';
import type { BrokerTransportClient } from '../src/transport/client/types';
import type { BrokerTransportServer } from '../src/transport/server/types';
import { createBrokerParticipant } from '../src/transport/shared/broker-participant';
import { createMqttBrokerAdapter } from '../src/transport/shared/mqtt-broker-adapter';

// interfaces

/** Where a side links: its broker's URL, and the run's password. */
export interface IMqttReach {
  password: string;
  url: string;
}

// constants

/** The name the demo's server serves, which the page's client connects through. */
export const DEMO_NAME = 'demo';

/** The ids each side links by, users of the broker the fixture starts. */
const SERVER_ID = 'server';
const CLIENT_ID = 'client';

// definition

/**
 * The demo's server over MQTT 5: a participant `server` of `reach`'s broker, a server over its
 * transport serving {@link DEMO_NAME}, not started; what stops both.
 */
export const serverOverMqtt = (reach: IMqttReach, options: IServerOptions) => {
  const participant = createBrokerParticipant({
    adapter: createMqttBrokerAdapter({ id: SERVER_ID, ...reach }),
  });
  const server = createServer<BrokerTransportServer, string>(
    { transport: participant.transportServer({ names: [DEMO_NAME] }) },
    options
  );

  return {
    server,
    [Symbol.asyncDispose]: async () => {
      await server[Symbol.asyncDispose]();
      await participant.stop();
    },
  };
};

/**
 * The page's client over MQTT 5: a participant `client` of `reach`'s broker, its client over its
 * transport, not connected; what connects it through {@link DEMO_NAME}, and what stops both.
 */
export const clientOverMqtt = (
  reach: IMqttReach,
  options?: { limits?: RouterLimitsOptions | undefined; metricsRegistry?: IMetricsRegistry }
): {
  client: IClient<BrokerTransportClient>;
  connect(): Promise<void>;
  name: string;
} & AsyncDisposable => {
  const participant = createBrokerParticipant({
    adapter: createMqttBrokerAdapter({ id: CLIENT_ID, ...reach }),
  });
  const client = createClient({ transport: participant.transportClient() }, options);

  return {
    client,
    connect: () => {
      return client.connect({ server: DEMO_NAME });
    },
    name: DEMO_NAME,
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
      await participant.stop();
    },
  };
};
