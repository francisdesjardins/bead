// ── Demo page ─────────────────────────────────────────────────────────────────

// The demo's page in Chromium, served by its launcher beside the Mosquitto `BEAD_MQTT_URL` names
// (`node tools/mqtt-broker.mjs run -- yarn test:demo`), as `?transport=mqtt` links it: where none
// is given, skipped, saying so, or failed where `BEAD_MQTT_REQUIRED=1`.

// dependencies

import { expect, test } from '@playwright/test';
import { serveMqttDemo } from '../../devtools/__tests__/fixtures';

// constants

const NO_BROKER =
  'no broker: BEAD_MQTT_URL or BEAD_MQTT_WS_URL is not set (node tools/mqtt-broker.mjs start)';
const HAS_BROKER =
  process.env['BEAD_MQTT_URL'] !== undefined && process.env['BEAD_MQTT_WS_URL'] !== undefined;
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';

/** How long a glyph has to cross, each way: the page's own timeout for it. */
const GLYPH_TIMEOUT = 60_000;

// definition

test.describe('the demo’s page, over MQTT 5', () => {
  test('sends a glyph to the server and receives one, its link kept', async ({ page }) => {
    test.skip(!HAS_BROKER && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(HAS_BROKER, NO_BROKER).toBe(true);
    test.setTimeout(3 * GLYPH_TIMEOUT);

    await using served = await serveMqttDemo();
    const failures: string[] = [];

    page.on('websocket', (socket) => {
      socket.on('socketerror', (error) => {
        failures.push(error);
      });
    });
    await page.goto(`${served.url}?transport=mqtt`);
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
    await page.click('button[data-action="writer"]');
    await expect(page.locator('#result')).toContainText('logged in as demo-writer');

    // * 8,386,816 bytes in parts each way, under the broker's Maximum Packet Size
    await page.click('button[data-action="upload"]');
    await expect(page.locator('#result')).toContainText(
      /^the server received the same glyph, 8,386,816 bytes/u,
      { timeout: GLYPH_TIMEOUT }
    );
    await page.click('button[data-action="download"]');
    await expect(page.locator('#result')).toContainText(/^a glyph received, 8,386,816 bytes/u, {
      timeout: GLYPH_TIMEOUT,
    });
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
    expect(failures).toEqual([]);
  });
});
