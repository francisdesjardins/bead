// ── Demo over MQTT 5 ──────────────────────────────────────────────────────────

// The demo's server and the page's client over the Mosquitto `BEAD_MQTT_URL` names
// (`node tools/mqtt-broker.mjs run -- yarn test:demo`), as `?transport=mqtt` links them: where none
// is given, skipped, saying so, or failed where `BEAD_MQTT_REQUIRED=1`.

// dependencies

import { expect, test } from '@playwright/test';
import { createMetricsRegistry } from '../../src/router/shared/metrics-registry';
import { SignUpClient } from '../gen/typescript/demo/v1/sign_up_bead';
import { offer } from '../offer';
import { clientOverMqtt, DEMO_NAME, serverOverMqtt } from '../over-mqtt';

// constants

const MQTT_URL = process.env['BEAD_MQTT_URL'];
const MQTT_PASSWORD = process.env['BEAD_MQTT_PASSWORD'] ?? '';
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)';

// definition

test.describe('the demo, over MQTT 5', () => {
  test('signs up over a broker, the page’s client connecting through the server’s name', async () => {
    test.skip(MQTT_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(MQTT_URL, NO_BROKER).toBeDefined();

    const reach = { password: MQTT_PASSWORD, url: MQTT_URL ?? '' };
    const metricsRegistry = createMetricsRegistry();

    await using serving = serverOverMqtt(reach, { metricsRegistry });

    offer(serving.server, metricsRegistry);
    await serving.server.transport.start();

    await using page = clientOverMqtt(reach);

    expect(page.name).toBe(DEMO_NAME);
    await page.connect();

    const { welcome } = await new SignUpClient(page.client).signUp({
      email: 'ada@example.org',
      name: 'ada',
      seats: 2,
    })();

    expect(welcome).toBe('welcome, ada: 2 seats held, confirmed by email to ada@example.org');
  });
});
