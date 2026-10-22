import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { samplesModule } from '../make-samples';
import { SAMPLES } from '../samples';

// definition

test.describe('samplesModule', () => {
  test("is samples.ts as it stands, examples/hello's files whole: node demo/make-samples.ts writes it again", async () => {
    const written = (await readFile(new URL('../samples.ts', import.meta.url), 'utf8')).replaceAll(
      '\r\n',
      '\n'
    );

    expect(written).toBe(await samplesModule());
  });

  test('offers each role on both sides, a file of its language each', () => {
    expect(Object.keys(SAMPLES)).toEqual(['resolvers', 'serving', 'calling']);

    for (const { csharp, typescript } of Object.values(SAMPLES)) {
      expect(csharp.file).toMatch(/^examples\/hello\/dotnet\/[A-Z][a-z]+\.cs$/u);
      expect(typescript.file).toMatch(/^examples\/hello\/typescript\/src\/[a-z]+\.ts$/u);
      expect(csharp.text.length).toBeGreaterThan(0);
      expect(typescript.text.length).toBeGreaterThan(0);
    }
  });
});
