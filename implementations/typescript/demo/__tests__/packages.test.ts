import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';

// constants

/** The demo's blueprint as the tab plans it first: both classes and a gateway, and a C# client. */
const DEMO_YAML = [
  'outputs:',
  '  - language: typescript',
  '    out: gen/typescript-gateway',
  '    gateway: {}',
  '  - language: csharp',
  '    out: gen/csharp-client',
  '    client: {}',
  '',
].join('\n');

// definition

test.describe('mountPackages', () => {
  // the demo's static build, served for each worker of the run
  let served: Awaited<ReturnType<typeof serveFolder>> | undefined;

  test.beforeAll(async () => {
    try {
      await access(join(PLAYGROUND, 'index.html'));
    } catch {
      throw new Error(`${PLAYGROUND} is not there: run yarn playground:build:file first`);
    }

    served = await serveFolder(PLAYGROUND);
  });

  test.afterAll(async () => {
    await served?.close();
  });

  test("opens by its fragment, the demo's blueprint planned and read back, and copies its YAML", async ({
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${served?.url ?? ''}#packages`);
    await expect(page.locator('#packages-scene')).toBeVisible();
    await expect(page.locator('#scene-tabs [aria-selected="true"]')).toHaveText('Packages');

    await expect(page.locator('#planner-summary')).toContainText('demo/gen/demo.blueprint.json');
    await expect(page.locator('#planner-yaml')).toHaveText(DEMO_YAML);
    await expect(page.locator('#planner-reading')).toHaveText(
      'parseConfig reads it back: 2 outputs, as planned.'
    );
    await expect(page.locator('#planner-routes')).toContainText('POST   /api/SignUp/signUp');

    await page.getByRole('button', { name: 'Copy the YAML' }).click();
    await expect(page.locator('#planner-copied')).toHaveText('Copied.');
    // a clipboard ends its lines as its system does
    const copied = await page.evaluate(() => {
      return navigator.clipboard.readText();
    });

    expect(copied.replaceAll('\r\n', '\n')).toBe(DEMO_YAML);
  });

  test('plans the shop, and finds a gateway that selects nothing GATEWAY_EMPTY as beadc words it', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#packages`);
    await page.getByRole('button', { name: 'A shop, for example' }).click();
    await expect(page.locator('#planner-findings')).toContainText('No finding');
    await expect(page.locator('#planner-transports')).toContainText(
      'gen/typescript-webSocket · mqtt · 2 addresses'
    );

    // * the C# client of the sign-up gains a gateway of what notifies and has no side effect: none
    const client = page.getByRole('region', { name: 'gen/csharp-client' });

    await client.getByRole('button', { name: 'gateway' }).click();

    const gateway = page
      .getByRole('region', { name: 'gen/csharp-client-gateway' })
      .getByRole('group', { name: 'gateway', exact: true });

    await gateway.getByRole('radio', { name: 'a selection' }).check();
    await gateway
      .getByRole('group', { name: 'kind' })
      .getByRole('checkbox', { name: 'notifies' })
      .check();
    await gateway
      .getByRole('group', { name: 'idempotencyLevel' })
      .getByRole('checkbox', { name: /NO_SIDE_EFFECTS/u })
      .check();

    await expect(page.locator('#planner-findings')).toContainText(
      'GATEWAY_EMPTYoutputs[2].gateway selects no request and no procedure that notifies: it would serve no route; take gateway out of it, or select one'
    );
    await expect(page.locator('#planner-yaml')).toContainText(
      '    gateway:\n      procedures:\n        kind: [notifies]\n        idempotencyLevel: [NO_SIDE_EFFECTS]'
    );
  });

  test('opens a blueprint of its own, and says what it cannot plan', async ({ page }) => {
    await page.goto(`${served?.url ?? ''}#packages`);

    const input = page.locator('#planner-file');

    await input.setInputFiles({
      name: 'not-json.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ no'),
    });
    await expect(page.locator('#planner-error')).toContainText('This file is no JSON');

    await input.setInputFiles({
      name: 'one.blueprint.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'bead-blueprint/1',
          services: [
            {
              serviceId: 7,
              serviceName: 'Clock',
              procedures: [{ procedureId: 1, procedureName: 'tick', procedureKind: 'notifies' }],
            },
          ],
        })
      ),
    });
    await expect(page.locator('#planner-error')).toBeHidden();
    await expect(page.locator('#planner-summary')).toContainText('one.blueprint.json');
    await expect(page.locator('#planner-yaml')).toHaveText(
      'outputs:\n  - language: typescript\n    out: gen/typescript-whole\n'
    );
  });
});
