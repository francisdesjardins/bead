// ── Interop server ────────────────────────────────────────────────────────────

// The TypeScript server of Bead's interop service, on 127.0.0.1, over WebSocket and over HTTP, each a
// server of its own, and over MQTT 5 where `BEAD_MQTT_URL` names a broker and over AMQP 1.0 where
// `BEAD_AMQP_URL` names one, its participant `ts-server` on each serving `interop-ts` alone and
// `interop-both` in a group with the C# side's: its first line on the standard output says their
// ports and those names, as {"port":n,"httpPort":m,"gatewayPort":g,"mqtt":[…],"amqp":[…]}; it
// serves until its standard input closes. A port given as its one
// argument is the WebSocket server's; none, any free one. The HTTP server takes any free one. Each
// names the origins `BEAD_INTEROP_ORIGINS` lists, separated by spaces, none when it is not set: a
// page of another origin calls them so. The C# side's interop server does the same, so each side's
// client calls the other's server. The gateway serves the Transcoding fixture and its document.
// `serve.ts` bundles it and runs it, as Node runs no import without
// its extension.

// dependencies

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createHTTPServer } from '../src/server/http-server';
import { createServer as createBeadServer } from '../src/server/server';
import { createWSServer } from '../src/server/ws-server';
import { createAmqpBrokerAdapter } from '../src/transport/shared/amqp-broker-adapter';
import { createBrokerParticipant } from '../src/transport/shared/broker-participant';
import { PLATFORM_CLOCK } from '../src/transport/shared/clock';
import { createMqttBrokerAdapter } from '../src/transport/shared/mqtt-broker-adapter';
import { startTranscoding } from '../src/transcoding/__tests__/transcoding-service';
import { interopCredentialsOf } from './credentials';
import { offerInterop } from './handlers';

// definition

const port = Number(process.argv[2] ?? 0);
const origins = (process.env['BEAD_INTEROP_ORIGINS'] ?? '').split(' ').filter((origin) => {
  return origin !== '';
});
// the interop service's credentials, on the clock both servers run on, the platform's
const credentials = interopCredentialsOf(PLATFORM_CLOCK);
const server = createWSServer<string>({ credentials, transport: { origins, WebSocketServer } });
const httpServer = createHTTPServer<string>({
  credentials,
  transport: {
    createServer: (listener) => {
      return createServer(listener);
    },
    origins,
  },
});

// * over each broker, a participant of its own: its name alone, and the one both sides serve in a
// group
const mqttUrl = process.env['BEAD_MQTT_URL'];
const amqpUrl = process.env['BEAD_AMQP_URL'];
const mqttParticipant =
  mqttUrl === undefined
    ? undefined
    : createBrokerParticipant({
        adapter: createMqttBrokerAdapter({
          id: 'ts-server',
          password: process.env['BEAD_MQTT_PASSWORD'],
          url: mqttUrl,
        }),
      });
const amqpParticipant =
  amqpUrl === undefined
    ? undefined
    : createBrokerParticipant({
        adapter: createAmqpBrokerAdapter({
          id: 'ts-server',
          password: process.env['BEAD_AMQP_PASSWORD'],
          url: amqpUrl,
        }),
      });
const participants = [mqttParticipant, amqpParticipant].filter((each) => {
  return each !== undefined;
});
const brokerServers = participants.flatMap((participant) => {
  return [
    participant.transportServer({ names: ['interop-ts'] }),
    participant.transportServer({ group: true, names: ['interop-both'] }),
  ].map((transport) => {
    return createBeadServer<typeof transport, string>({ transport }, { credentials });
  });
});

for (const each of [server, httpServer, ...brokerServers]) {
  each.router.on('error', (error, connectionHandle) => {
    process.stderr.write(`${connectionHandle ?? 'no connection'}: ${error.message}
`);
  });
  offerInterop(each);
}

for (const each of brokerServers) {
  await each.transport.start();
}

const address = await server.transport.start({
  address: '127.0.0.1',
  findOpenPort: port === 0,
  port,
});
const httpAddress = await httpServer.transport.start({ address: '127.0.0.1', findOpenPort: true });
const transcoding = await startTranscoding({
  origins,
  maximumBodyBytes: 1024,
  maximumConnectionsPerAddress: 1,
});

process.stdout.write(`${JSON.stringify({
  gatewayPort: transcoding.port,
  httpPort: httpAddress.port,
  port: address.port,
  ...(mqttParticipant === undefined ? {} : { mqtt: ['interop-ts', 'interop-both'] }),
  ...(amqpParticipant === undefined ? {} : { amqp: ['interop-ts', 'interop-both'] }),
})}
`);

// served until whoever started it lets go of its input
process.stdin.on('end', () => {
  void Promise.all([
    server[Symbol.asyncDispose](),
    httpServer[Symbol.asyncDispose](),
    transcoding[Symbol.asyncDispose](),
    ...brokerServers.map((each) => {
      return each[Symbol.asyncDispose]();
    }),
  ])
    .then(() => {
      return Promise.all(
        participants.map((participant) => {
          return participant.stop();
        })
      );
    })
    .finally(() => {
      process.exit(0);
    });
});
process.stdin.resume();
