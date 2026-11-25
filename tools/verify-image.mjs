#!/usr/bin/env node
// The verify block a document gives a reader for beadc's image, run as the reader runs it
// (decision 0055): the fenced `sh` block and the fenced `powershell` block that follow a
// `<!-- verify-image -->` marker, the first under `sh`, the second under `pwsh`, each in an empty
// directory of its own, into which each clones `bead-pinned`. A block passes when it ends with
// `BEADC_IMAGE` set to the image by the digest the block resolved, `$digest`.
//
//   node tools/verify-image.mjs --from <file>                     each block as written
//   node tools/verify-image.mjs --from <file> --version <x.y.z>   its `v=` line set to that version
//   node tools/verify-image.mjs --from <file> --digest <sha256:…> and its digest that one
//
// image.yml runs builder/README.md's general block against the index it just signed, and
// guides.yml runs the getting-started guide's block. The blocks need git, Docker's buildx, GitHub's
// CLI with a token and cosign 3, and the network. Exit 1 on a problem, one a line; exit 2 on a usage
// error.
//
// ! a block sets nothing to fail on: the chain alone ties the export to every check, so a block's
// exit says nothing and the tool reads `BEADC_IMAGE` after it, from a line it appends

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ── Blocks ────────────────────────────────────────────────────────────────────

export const MARKER = '<!-- verify-image -->';
export const IMAGE = 'ghcr.io/francisdesjardins/beadc';
export const LANGUAGES = ['sh', 'powershell'];

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// the line that names the version, in each language
const VERSION_LINE = { sh: /^v=.*$/m, powershell: /^\$v = .*$/m };

// the `sh` and the `powershell` block after the marker, each the first fence of its language
// before the next heading
export const blocksOf = (text) => {
  const at = text.indexOf(MARKER);
  if (at < 0) {
    return { problems: [`no ${MARKER} marker`] };
  }
  const blocks = {};
  const problems = [];
  // the fence open, its language and its lines, or null between fences
  let open = null;
  for (const line of text.slice(at + MARKER.length).split(/\r?\n/)) {
    if (open !== null) {
      if (/^```[ \t]*$/.test(line)) {
        if (LANGUAGES.includes(open.language) && blocks[open.language] === undefined) {
          blocks[open.language] = `${open.lines.join('\n')}\n`;
        }
        open = null;
      } else {
        open.lines.push(line);
      }
    } else if (/^#{1,6} /.test(line)) {
      break;
    } else if (line.startsWith('```')) {
      open = { language: line.slice(3).trim(), lines: [] };
    }
    if (LANGUAGES.every((each) => blocks[each] !== undefined)) {
      break;
    }
  }
  for (const language of LANGUAGES) {
    if (blocks[language] === undefined) {
      problems.push(`no \`${language}\` block after the marker`);
    }
  }
  return { blocks, problems };
};

// a block with its version line set to a version, or as written when none is given
export const withVersion = (block, options) => {
  const { language, version } = options;
  const line = VERSION_LINE[language];
  const found = line.exec(block);
  if (found === null) {
    return { problems: [`the \`${language}\` block names no version, \`${line.source}\``] };
  }
  const written =
    version === undefined
      ? block
      : block.replace(line, language === 'sh' ? `v=${version}` : `$v = '${version}'`);
  const named = line.exec(written)[0];
  if (named.includes('<')) {
    return { problems: [`the \`${language}\` block's ${named} is a placeholder: give --version`] };
  }
  return { block: written, problems: [] };
};

// the block, then the line that writes what it left, into the file VERIFY_IMAGE_RESULT names
export const scriptOf = (block, language) => {
  const tail =
    language === 'sh'
      ? `printf 'BEADC_IMAGE=%s\\ndigest=%s\\n' "\${BEADC_IMAGE-}" "\${digest-}" > "$VERIFY_IMAGE_RESULT"`
      : `Set-Content -LiteralPath $env:VERIFY_IMAGE_RESULT -Value @("BEADC_IMAGE=$env:BEADC_IMAGE", "digest=$digest")`;
  return `${block.trimEnd()}\n${tail}\n`;
};

// what a run left, `BEADC_IMAGE` and `$digest`, read from the result's lines
export const resultOf = (text) => {
  const result = { image: '', digest: '' };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('BEADC_IMAGE=')) {
      result.image = line.slice('BEADC_IMAGE='.length);
    } else if (line.startsWith('digest=')) {
      result.digest = line.slice('digest='.length);
    }
  }
  return result;
};

// the problems of a run's result: `BEADC_IMAGE` set to the image by the digest the block resolved,
// and that digest the one expected, when one is
export const judge = (result, options) => {
  const { language, expected } = options;
  if (result === null) {
    return [`the \`${language}\` block left no result`];
  }
  if (!DIGEST.test(result.digest)) {
    return [`the \`${language}\` block resolved no digest, [${result.digest}]`];
  }
  const problems = [];
  if (result.image !== `${IMAGE}@${result.digest}`) {
    problems.push(
      `the \`${language}\` block left BEADC_IMAGE [${result.image}], not ${IMAGE}@${result.digest}`
    );
  }
  if (expected !== undefined && result.digest !== expected) {
    problems.push(`the \`${language}\` block resolved ${result.digest}, not ${expected}`);
  }
  return problems;
};

// ── Runs ──────────────────────────────────────────────────────────────────────

const SHELLS = {
  sh: { command: 'sh', arguments: [], extension: 'sh' },
  powershell: {
    command: 'pwsh',
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File'],
    extension: 'ps1',
  },
};

// one block run by its shell in an empty directory, its output the caller's; the result, or null
export const runBlock = (block, language) => {
  const shell = SHELLS[language];
  const work = mkdtempSync(join(tmpdir(), 'verify-image-work-'));
  const own = mkdtempSync(join(tmpdir(), 'verify-image-'));
  try {
    const script = join(own, `block.${shell.extension}`);
    const out = join(own, 'result');
    writeFileSync(script, scriptOf(block, language));
    // ! the caller's BEADC_IMAGE never reaches the block: a failed chain would leave it set
    const env = { ...process.env, VERIFY_IMAGE_RESULT: out };
    delete env.BEADC_IMAGE;
    const run = spawnSync(shell.command, [...shell.arguments, script], {
      cwd: work,
      env,
      stdio: 'inherit',
    });
    if (run.error !== undefined) {
      return { error: `${shell.command}: ${run.error.message}` };
    }
    try {
      return { result: resultOf(readFileSync(out, 'utf8')) };
    } catch {
      return { result: null };
    }
  } finally {
    for (const folder of [work, own]) {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    }
  }
};

// every block of a file, run and judged; the problems, one a line
export const verifyImage = (text, options) => {
  const { version, digest } = options;
  const { blocks, problems } = blocksOf(text);
  if (problems.length > 0) {
    return problems;
  }
  const written = LANGUAGES.map((language) => {
    return { language, ...withVersion(blocks[language], { language, version }) };
  });
  const unwritten = written.flatMap((each) => {
    return each.problems;
  });
  if (unwritten.length > 0) {
    return unwritten;
  }
  return written.flatMap((each) => {
    console.log(`verify-image: the \`${each.language}\` block`);
    const run = runBlock(each.block, each.language);
    if (run.error !== undefined) {
      return [run.error];
    }
    const judged = judge(run.result, { language: each.language, expected: digest });
    if (judged.length === 0) {
      console.log(
        `verify-image: the \`${each.language}\` block set BEADC_IMAGE=${run.result.image}`
      );
    }
    return judged;
  });
};

if (import.meta.main) {
  const usage =
    'usage: node tools/verify-image.mjs --from <file> [--version <x.y.z>] [--digest <sha256:…>]';
  let options;
  try {
    ({ values: options } = parseArgs({
      options: {
        from: { type: 'string' },
        version: { type: 'string' },
        digest: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error(`verify-image: ${error.message}`);
    console.error(usage);
    process.exit(2);
  }
  const wrong = [
    options.from === undefined ? 'no --from' : null,
    options.version !== undefined && !VERSION.test(options.version)
      ? `--version ${options.version} is no x.y.z`
      : null,
    options.digest !== undefined && !DIGEST.test(options.digest)
      ? `--digest ${options.digest} is no sha256 digest`
      : null,
  ].filter((each) => {
    return each !== null;
  });
  if (wrong.length > 0) {
    for (const each of wrong) {
      console.error(`verify-image: ${each}`);
    }
    console.error(usage);
    process.exit(2);
  }
  const problems = verifyImage(readFileSync(options.from, 'utf8'), options);
  for (const problem of problems) {
    console.error(`verify-image: ${options.from}: ${problem}`);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
