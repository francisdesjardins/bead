// ── Demo samples ─────────────────────────────────────────────────────────────

// What the page shows of `examples/hello`: its resolvers, its server and its client, each on both
// sides, as the repository holds them, written into `samples.ts` so the page bundles them. Run from
// the package, `node demo/make-samples.ts`; the demo's tests hold `samples.ts` to what this writes,
// so a sample never parts from the code the example builds and runs.

// dependencies

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// constants

const ROOT = new URL('../../../', import.meta.url);
const OUT = new URL('./samples.ts', import.meta.url);

/** Each role the page offers, and the file of it on each side, from the repository's root. */
const FILES = Object.freeze({
  resolvers: {
    csharp: 'examples/hello/dotnet/Resolvers.cs',
    typescript: 'examples/hello/typescript/src/resolvers.ts',
  },
  serving: {
    csharp: 'examples/hello/dotnet/Serving.cs',
    typescript: 'examples/hello/typescript/src/serving.ts',
  },
  calling: {
    csharp: 'examples/hello/dotnet/Calling.cs',
    typescript: 'examples/hello/typescript/src/calling.ts',
  },
} as const);

// helpers

const textOf = async (file: string): Promise<string> => {
  // * a file's lines as LF, whatever a checkout wrote
  return (await readFile(new URL(file, ROOT), 'utf8')).replaceAll('\r\n', '\n');
};

// definition

/** The text of `samples.ts`, as this script writes it from the example's files. */
export const samplesModule = async (): Promise<string> => {
  const roles = await Promise.all(
    Object.entries(FILES).map(async ([role, { csharp, typescript }]) => {
      const [csharpText, typescriptText] = await Promise.all([textOf(csharp), textOf(typescript)]);

      return [
        `  ${role}: {`,
        `    csharp: { file: ${JSON.stringify(csharp)}, text: ${JSON.stringify(csharpText)} },`,
        `    typescript: { file: ${JSON.stringify(typescript)}, text: ${JSON.stringify(typescriptText)} },`,
        '  },',
      ].join('\n');
    })
  );

  return [
    '// ── Demo samples ─────────────────────────────────────────────────────────────',
    '',
    "// examples/hello's files, as `make-samples.ts` writes them: never edited by hand.",
    '',
    '/** Each role the page offers, its file and its text on each side. */',
    'export const SAMPLES = Object.freeze({',
    ...roles,
    '} as const);',
    '',
  ].join('\n');
};

if (import.meta.main) {
  await writeFile(OUT, await samplesModule());
  process.stdout.write(`written ${fileURLToPath(OUT)}\n`);
}
