// ── MQTT page ─────────────────────────────────────────────────────────────────

// The script of a page a browser loads: a broker's client transport over MQTT.js's browser build,
// its link a WebSocket of subprotocol `mqtt` to a Mosquitto (spec 15.25), calling the interop
// service through a server's name; and what the adapter refuses there, a TLS client certificate,
// which no page chooses (spec 15.26).

// dependencies

import { InteropClient } from '../interop/generated/interop_bead';
import { createClient } from '../src/client/client';
import { CredentialScheme } from '../src/router/shared/constants';
import { createBrokerParticipant } from '../src/transport/shared/broker-participant';
import { createMqttBrokerAdapter } from '../src/transport/shared/mqtt-broker-adapter';

// interfaces

/** What the page came to over MQTT 5: what `echo` and `whoami` answered, or why it failed. */
export interface IMqttPageReport {
  echoed?: unknown;
  failure?: string;
  /** Whether its connection said it was secure, its broker on the loopback. */
  isSecure?: boolean;
  whoami?: unknown;
}

/** Where the page links and what it calls: its broker, its id, the run's password and a name. */
export interface IMqttPageTarget {
  id: string;
  password: string;
  server: string;
  url: string;
}

// definition

/**
 * Links `target.id` to its broker over its WebSocket, connects through `target.server`, calls `echo`
 * and `whoami` presenting an `ELSEWHERE` its DATA carries, and stops; a failure ends it, saying why.
 */
const callOverMqtt = async (target: IMqttPageTarget): Promise<IMqttPageReport> => {
  const participant = createBrokerParticipant({
    adapter: createMqttBrokerAdapter({ id: target.id, password: target.password, url: target.url }),
  });
  const client = createClient({ transport: participant.transportClient() });

  try {
    await client.connect({ server: target.server });

    const interop = new InteropClient(client);
    const echoed = await interop.echo({ over: 'MQTT 5' })();
    const whoami = await interop.whoami(null)({
      credential: { carried: 'Interop sub=ada', scheme: CredentialScheme.ELSEWHERE },
    });

    return { echoed, isSecure: client.router.transport.isSecure, whoami };
  } catch (error) {
    return { failure: String(error) };
  } finally {
    await client[Symbol.asyncDispose]();
    await participant.stop();
  }
};

/** The refusal the adapter meets in a page given a TLS client certificate, its message. */
const refuseCertificate = (): string => {
  try {
    createMqttBrokerAdapter({
      id: 'page',
      tls: { cert: 'certificate', key: 'key' },
      url: 'wss://broker.example/mqtt',
    });
  } catch (error) {
    return (error as Error).message;
  }

  return 'taken';
};

Object.assign(globalThis, { callOverMqtt, refuseCertificate });
