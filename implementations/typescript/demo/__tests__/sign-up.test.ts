import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';

// constants

const FIELDS = Object.freeze(['name', 'seats', 'email', 'phone'] as const);

/** What a refusal of the broken sign-up writes under each field. */
const MESSAGES = Object.freeze({
  email: 'does not match regex pattern `^[^@ ]+@[^@ .]+(\\.[^@ .]+)+$`',
  name: 'does not match regex pattern `^[a-z][a-z0-9-]*$`',
  phone: 'does not match regex pattern `^\\+[1-9][0-9]{6,14}$`',
  seats: 'must be greater than or equal to 1 and less than or equal to 10',
});

// helpers

/** The lines of the envelopes' log that open a sign-up: a REQUEST to service 2's procedure 1. */
const requestsOf = (page: Page) => {
  return page.locator('#envelopes li', { hasText: /^→ REQUEST #\d+ signUp \(2\/1\)/u });
};

/** Each field marked refused, described by its messages, which say what `MESSAGES` holds. */
const expectBound = async (page: Page): Promise<void> => {
  for (const name of FIELDS) {
    const input = page.locator(`#sign-up-${name}`);
    const messages = page.locator(`#sign-up-${name}-messages`);

    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAttribute(
      'aria-describedby',
      `sign-up-${name}-messages sign-up-${name}-hint`
    );
    await expect(messages).toBeVisible();
    await expect(messages).toHaveText(MESSAGES[name]);
  }

  // * the first field refused takes the focus, and the violation of no field stands above the form
  await expect(page.locator('#sign-up-name')).toBeFocused();
  await expect(page.locator('#sign-up-unbound')).toHaveText('only one of email, phone can be set');
};

// definition

test.describe('mountSignUp', () => {
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

  // a page of it, connected to its worker
  test.beforeEach(async ({ page }) => {
    await page.goto(served?.url ?? '');
    await expect(page.locator('#connection')).toHaveAttribute('data-state', 'open');
  });

  test('signs up the valid sign-up it is filled with', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.locator('#sign-up-status')).toHaveText(
      'signed up: welcome, ada: 2 seats held, confirmed by email to ada@example.org'
    );
    await expect(requestsOf(page)).toHaveCount(1);
    await expect(page.locator('[aria-invalid]')).toHaveCount(0);
  });

  test('binds each violation of the server’s refusal to its field, and focuses the first', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Break several fields' }).click();
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.locator('#sign-up-status')).toHaveText(
      'refused by the server before its resolver: PAYLOAD_INVALID, 5 violations'
    );
    await expectBound(page);
    await expect(requestsOf(page)).toHaveCount(1);
  });

  test('clears a field’s messages as it changes, and every one as the form is sent again', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Break several fields' }).click();
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expectBound(page);

    await page.locator('#sign-up-name').fill('ada');

    await expect(page.locator('#sign-up-name')).not.toHaveAttribute('aria-invalid');
    await expect(page.locator('#sign-up-name')).toHaveAttribute(
      'aria-describedby',
      'sign-up-name-hint'
    );
    await expect(page.locator('#sign-up-name-messages')).toBeHidden();
    await expect(page.locator('#sign-up-seats')).toHaveAttribute('aria-invalid', 'true');

    await page.locator('#sign-up-seats').fill('3');
    await page.locator('#sign-up-email').fill('');
    await page.locator('#sign-up-phone').fill('+15550100123');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.locator('#sign-up-status')).toHaveText(
      'signed up: welcome, ada: 3 seats held, confirmed by text to +15550100123'
    );
    await expect(page.locator('[aria-invalid]')).toHaveCount(0);
    await expect(page.locator('#sign-up-unbound')).toBeHidden();
  });

  test('refuses before anything goes when it validates, with the same violations', async ({
    page,
  }) => {
    await page.getByLabel('Validate before sending').check();
    await page.getByRole('button', { name: 'Break several fields' }).click();
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.locator('#sign-up-status')).toHaveText(
      'refused by the client before it went, nothing on the wire: PAYLOAD_INVALID, 5 violations'
    );
    await expectBound(page);

    // * a valid one sent after it is the one request the log holds: the refused one never went
    await page.getByRole('button', { name: 'Fill a valid one' }).click();
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.locator('#sign-up-status')).toHaveText(/^signed up: /u);
    await expect(requestsOf(page)).toHaveCount(1);
  });

  test('shows a violation of no field above the form, and focuses it', async ({ page }) => {
    await page.locator('#sign-up-phone').fill('+15550100123');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.locator('#sign-up-status')).toHaveText(
      'refused by the server before its resolver: PAYLOAD_INVALID, 1 violation'
    );
    await expect(page.locator('#sign-up-unbound')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('only one of email, phone can be set');
    await expect(page.locator('#sign-up-unbound')).toBeFocused();
    await expect(page.locator('[aria-invalid]')).toHaveCount(0);
  });

  test('shows the same sign-up over HTTP: its curl as it is filled, and the answer a gateway gives it', async ({
    page,
  }) => {
    const request = page.locator('#sign-up-http-request');
    const answer = page.locator('#sign-up-http-answer');

    await page.locator('#sign-up-http > summary').click();

    // * the internal demo's origin, as this page's server is a worker, the body in Bead's JSON form
    await expect(request).toContainText('curl -X POST http://localhost:8080/api/SignUp/signUp');
    await expect(request).toContainText(`-d '{"name":"ada","seats":2,"email":"ada@example.org"}'`);

    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(answer).toContainText('HTTP/1.1 200 OK');
    await expect(answer).toContainText('"welcome": "welcome, ada: 2 seats held');

    await page.getByRole('button', { name: 'Break several fields' }).click();
    await expect(request).toContainText(`"name":"9 Lives!"`);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(answer).toContainText('HTTP/1.1 422 Unprocessable Content');
    await expect(answer).toContainText('content-type: application/problem+json');

    for (const pointer of ['#/name', '#/seats', '#/email', '#/phone']) {
      await expect(answer).toContainText(`"pointer": "${pointer}"`);
    }

    await expect(answer).toContainText('"title": "PAYLOAD_INVALID"');

    // its OpenAPI document, beadc's, its one path the sign-up's route
    await page.locator('#sign-up-openapi summary').click();
    await expect(page.locator('#sign-up-openapi-document')).toContainText('"openapi": "3.1.1"');
    await expect(page.locator('#sign-up-openapi-document')).toContainText('"/api/SignUp/signUp"');
  });
});
