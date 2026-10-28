// ── MQTT page ─────────────────────────────────────────────────────────────────

// The script of a page a browser loads: a broker's client transport over MQTT.js's browser build,
// its link a WebSocket of subprotocol `mqtt` to a Mosquitto (spec 15.25), calling the interop
// service through a server's name; its adapter alone, through a burst of publications that a
// Chromium would fragment as one message; and what the adapter refuses there, a TLS client
// certificate, which no page chooses (spec 15.26).

// dependencies

import { InteropClient } from '../interop/generated/interop_bead';
import { createClient } from '../src/client/client';
import { CredentialScheme } from '../src/router/shared/constants';
import { createBrokerParticipant } from '../src/transport/shared/broker-participant';
import { BROKER_PUBLISHED } from '../src/transport/shared/constants';
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

/**
 * Links `target.id` to its broker over its WebSocket and publishes to its own inbox, all at once,
 * publications of the largest payload its broker takes, together past 64 KiB, each of the byte of
 * its index; what came of them, and whether its link held.
 */
const burstOverMqtt = async (
  target: Omit<IMqttPageTarget, 'server'>
): Promise<{ failure?: string; heard?: number[]; isLinked?: boolean; taken?: number }> => {
  const adapter = createMqttBrokerAdapter(target);
  const inbox = ['bead', 'i', target.id];
  const heard: number[] = [];

  adapter.on('message', (message) => {
    heard.push(message.payload[0] ?? -1);
    message.settle();
  });

  try {
    await adapter.start();
    await adapter.subscribe(inbox);

    const size = adapter.maximumPayloadBytes(inbox);
    const published = await Promise.all(
      Array.from({ length: Math.ceil(196_608 / size) }, (_, index) => {
        return adapter.publish({ payload: new Uint8Array(size).fill(index), topic: inbox });
      })
    );

    while (heard.length < published.length && adapter.isLinked) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }

    return {
      heard,
      isLinked: adapter.isLinked,
      taken: published.filter((outcome) => {
        return outcome === BROKER_PUBLISHED.TAKEN;
      }).length,
    };
  } catch (error) {
    return { failure: String(error) };
  } finally {
    await adapter.stop();
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

Object.assign(globalThis, { burstOverMqtt, callOverMqtt, refuseCertificate });
