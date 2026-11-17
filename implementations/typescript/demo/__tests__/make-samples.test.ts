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

  test('offers each role in TypeScript, C# and Rust, a file of its language each', () => {
    expect(Object.keys(SAMPLES)).toEqual(['resolvers', 'serving', 'calling']);

    for (const { csharp, rust, typescript } of Object.values(SAMPLES)) {
      expect(csharp.file).toMatch(/^examples\/hello\/dotnet\/[A-Z][a-z]+\.cs$/u);
      expect(rust.file).toMatch(/^examples\/hello\/rust\/src\/[a-z]+\.rs$/u);
      expect(typescript.file).toMatch(/^examples\/hello\/typescript\/src\/[a-z]+\.ts$/u);

      for (const { text } of [csharp, rust, typescript]) {
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });
});
