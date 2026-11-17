import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// the static host the DevTools extension's tests serve the same build with
import { PLAYGROUND, serveFolder } from '../../devtools/__tests__/fixtures';
import { SAMPLES } from '../samples';

// constants

/** Each role's tab, by its name, and each language's radio, by its name. */
const ROLES = Object.freeze({
  calling: 'Its client',
  resolvers: 'Its resolvers',
  serving: 'Its server',
});

const LANGUAGES = Object.freeze({ csharp: 'C#', rust: 'Rust', typescript: 'TypeScript' });

// helpers

/** What the panel shows: its tab selected, its language checked, and its file. */
const shownOf = async (page: Page) => {
  return {
    file: await page.locator('#side-file').textContent(),
    language: (await page.locator('#sides-languages [aria-checked="true"]').textContent())?.trim(),
    role: (await page.locator('#sides-tabs [aria-selected="true"]').textContent())?.trim(),
  };
};

/** The box of an element of the page, its vertical middle with it. */
const boxOf = async (page: Page, selector: string) => {
  const box = await page.locator(selector).boundingBox();

  expect(box, selector).not.toBeNull();

  return { ...box, middle: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
};

// definition

test.describe('mountSides', () => {
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

  test('shows each role in each of three languages, the language kept across roles', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#code`);

    // * its resolvers first, in TypeScript, as examples/hello holds them
    expect(await shownOf(page)).toEqual({
      file: SAMPLES.resolvers.typescript.file,
      language: 'TypeScript',
      role: 'Its resolvers',
    });
    await expect(page.locator('#sides-panel')).toHaveAttribute(
      'aria-labelledby',
      'sides-resolvers side-file'
    );

    for (const [language, languageName] of Object.entries(LANGUAGES)) {
      await page.getByRole('radio', { name: languageName }).click();

      for (const [role, roleName] of Object.entries(ROLES)) {
        await page.getByRole('tab', { name: roleName }).click();

        const sample = SAMPLES[role as keyof typeof SAMPLES][language as keyof typeof LANGUAGES];

        expect(await shownOf(page), `${roleName} in ${languageName}`).toEqual({
          file: sample.file,
          language: languageName,
          role: roleName,
        });
        expect(await page.locator('#sides-panel').textContent()).toBe(sample.text);
      }
    }

    // * changing the language keeps the role
    await page.getByRole('tab', { name: 'Its client' }).click();
    await page.getByRole('radio', { name: 'C#' }).click();
    expect(await shownOf(page)).toEqual({
      file: SAMPLES.calling.csharp.file,
      language: 'C#',
      role: 'Its client',
    });
  });

  test('colours the file by its language’s tokens, written as text, never as HTML', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#code`);
    await page.getByRole('radio', { name: 'C#' }).click();

    const panel = page.locator('#sides-panel');

    // * C#'s generics read as text: `HelloServer<TData>` makes no element
    expect(
      await panel.evaluate((pre) => {
        return {
          elements: [...pre.querySelectorAll('*')].map(({ className, tagName }) => {
            return `${tagName.toLowerCase()}.${className}`;
          }),
          text: pre.textContent,
        };
      })
    ).toEqual({
      elements: expect.arrayContaining(['span.tok-keyword', 'span.tok-string']) as string[],
      text: SAMPLES.resolvers.csharp.text,
    });
    expect(
      await panel.evaluate((pre) => {
        return [...pre.querySelectorAll('*')].every((element) => {
          return element.tagName === 'SPAN' && /^tok-[a-z]+$/u.test(element.className);
        });
      })
    ).toBe(true);
    await expect(panel.locator('.tok-keyword').first()).not.toHaveCSS(
      'color',
      await panel.evaluate((pre) => {
        return getComputedStyle(pre).color;
      })
    );

    // a lifetime's word is no keyword in Rust
    await page.getByRole('radio', { name: 'Rust' }).click();
    await expect(panel.locator('.tok-keyword', { hasText: /^static$/u })).toHaveCount(0);
  });

  test('keeps the language a visitor chose for the next visit, TypeScript where none is kept', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#code`);
    await page.getByRole('radio', { name: 'Rust' }).click();
    await page.reload();
    expect((await shownOf(page)).language).toBe('Rust');
    await expect(page.locator('#side-file')).toHaveText(SAMPLES.resolvers.rust.file);

    // * what is kept and is no language shows TypeScript
    await page.evaluate(() => {
      localStorage.setItem('bead:code-language', 'cobol');
    });
    await page.reload();
    expect((await shownOf(page)).language).toBe('TypeScript');
  });

  test('shows TypeScript where the browser keeps nothing, and still changes language', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get: () => {
          throw new DOMException('refused', 'SecurityError');
        },
      });
    });
    await page.goto(`${served?.url ?? ''}#code`);
    expect((await shownOf(page)).language).toBe('TypeScript');

    await page.getByRole('radio', { name: 'Rust' }).click();
    expect((await shownOf(page)).language).toBe('Rust');
  });

  test('changes role by a click and by the arrow keys, Home and End, the focus with the tab', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#code`);

    await page.getByRole('tab', { name: 'Its client' }).click();
    expect(await shownOf(page)).toEqual({
      file: SAMPLES.calling.typescript.file,
      language: 'TypeScript',
      role: 'Its client',
    });

    // * from the last, the right arrow comes back to the first
    await page.getByRole('tab', { name: 'Its client' }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Its resolvers' })).toBeFocused();
    expect((await shownOf(page)).role).toBe('Its resolvers');

    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Its client' })).toBeFocused();
    await page.keyboard.press('Home');
    expect((await shownOf(page)).role).toBe('Its resolvers');
    await page.keyboard.press('End');
    expect((await shownOf(page)).role).toBe('Its client');

    // one tab stop for the tabs: the one selected
    await expect(page.locator('#sides-tabs [tabindex="0"]')).toHaveCount(1);
  });

  test('changes language by the arrow keys, one tab stop for the group, its focus shown', async ({
    page,
  }) => {
    await page.goto(`${served?.url ?? ''}#code`);

    // * Tab goes from the role selected to the language checked, then to the file
    await page.getByRole('tab', { name: 'Its server' }).click();
    await page.keyboard.press('Tab');

    const typescript = page.getByRole('radio', { name: 'TypeScript' });

    await expect(typescript).toBeFocused();
    await expect(typescript).not.toHaveCSS('outline-style', 'none');

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'C#' })).toBeFocused();
    expect(await shownOf(page)).toEqual({
      file: SAMPLES.serving.csharp.file,
      language: 'C#',
      role: 'Its server',
    });

    // from the first, the left arrow goes round to the last
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: 'Rust' })).toBeFocused();
    expect((await shownOf(page)).language).toBe('Rust');
    await expect(page.locator('#sides-languages [tabindex="0"]')).toHaveCount(1);

    await page.keyboard.press('Tab');
    await expect(page.locator('#sides-panel')).toBeFocused();
  });

  test('sets the language on the roles’ row on a desktop, on the file’s line on a phone, its own row at 320 px, the file in the page’s scroll on a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${served?.url ?? ''}#code`);
    await page.getByRole('radio', { name: 'Rust' }).click();

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });

      const at = `at ${String(width)} px`;
      const roles = await boxOf(page, '#sides-tabs');
      const languages = await boxOf(page, '#sides-languages');
      const file = await boxOf(page, '.sides-file');
      const code = await boxOf(page, '#sides-panel');
      const below = (box: typeof roles): number => {
        return (box.y ?? 0) + (box.height ?? 0) - 1;
      };

      // * the roles on one line, which scrolls sideways where it runs on
      expect(
        await page.locator('#sides-tabs [role="tab"]').evaluateAll((tabs) => {
          return new Set(
            tabs.map((tab) => {
              return tab.getBoundingClientRect().top;
            })
          ).size;
        }),
        at
      ).toBe(1);

      if (width === 1280) {
        expect(Math.abs(languages.middle - roles.middle), at).toBeLessThanOrEqual(1);
        expect(file.y, at).toBeGreaterThan(below(roles));
      } else if (width === 390) {
        // two rows above the code: the roles, then the file and the language
        expect(Math.abs(languages.middle - file.middle), at).toBeLessThanOrEqual(1);
        expect(file.y, at).toBeGreaterThan(below(roles));
      } else {
        // the path's line too narrow to share: the language a row of its own
        expect(languages.y, at).toBeGreaterThan(below(roles));
        expect(file.y, at).toBeGreaterThan(below(languages));
      }

      expect(code.y, at).toBeGreaterThan(below(file));
      // the path whole where it fits, else cut at its head, its file's name kept in view
      expect(
        await page.locator('.sides-file').evaluate((line) => {
          const text = line.querySelector('span')?.firstChild;
          const range = document.createRange();
          const end = text?.textContent?.length ?? 0;

          if (text === null || text === undefined) {
            return 'no path';
          }

          range.setStart(text, end - 'resolvers.rs'.length);
          range.setEnd(text, end);

          const name = range.getBoundingClientRect();
          const box = line.getBoundingClientRect();

          return name.left >= box.left - 0.5 && name.right <= box.right + 0.5;
        }),
        at
      ).toBe(true);
      // * no scroll inside another on a phone: the file runs down the page, and across alone
      expect(
        await page.locator('#sides-panel').evaluate((pre) => {
          return pre.scrollHeight > pre.clientHeight;
        }),
        at
      ).toBe(width === 1280);
    }
  });
});
