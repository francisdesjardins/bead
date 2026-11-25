import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import {
  blocksOf,
  IMAGE,
  judge,
  MARKER,
  resultOf,
  runBlock,
  scriptOf,
  withVersion,
} from '../verify-image.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const OTHER = `sha256:${'cd'.repeat(32)}`;

const DOCUMENT = [
  '# A guide',
  '',
  '```sh',
  'echo before the marker',
  '```',
  '',
  MARKER,
  '',
  '```text',
  'not a block of either language',
  '```',
  '',
  '```sh',
  '# a comment, not a heading',
  'v=<version>',
  'echo "$v"',
  '```',
  '',
  '```powershell',
  '# in PowerShell 7.6 (pwsh)',
  "$v = '<version>'",
  '"$v"',
  '```',
  '',
  '```sh',
  'echo a later block',
  '```',
  '',
].join('\n');

// a block of each language whose chain passes, or fails before the export, as the verify blocks'
const CHAINS = {
  sh: (pass) => {
    return [
      `digest='${DIGEST}'`,
      `image="${IMAGE}@$digest"`,
      `[ -n "$digest" ] && node -e 'process.exit(${pass ? 0 : 1})' &&`,
      '  export BEADC_IMAGE="$image"',
      '',
    ].join('\n');
  },
  powershell: (pass) => {
    return [
      `$digest = '${DIGEST}'`,
      `$image = "${IMAGE}@$digest"`,
      'if ($digest) {',
      `  node -e 'process.exit(${pass ? 0 : 1})' &&`,
      '    Set-Item Env:BEADC_IMAGE $image',
      '}',
      '',
    ].join('\n');
  },
};

const has = (command) => {
  return spawnSync(command, ['-c', 'exit 0'], { stdio: 'ignore' }).error === undefined;
};

// ── Blocks ────────────────────────────────────────────────────────────────────

describe('blocksOf', () => {
  test('takes the first sh and powershell blocks after the marker, a comment no heading', () => {
    const { blocks, problems } = blocksOf(DOCUMENT);
    assert.deepEqual(problems, []);
    assert.equal(blocks.sh, '# a comment, not a heading\nv=<version>\necho "$v"\n');
    assert.equal(blocks.powershell, '# in PowerShell 7.6 (pwsh)\n$v = \'<version>\'\n"$v"\n');
  });

  test('refuses a document without the marker', () => {
    assert.deepEqual(blocksOf('```sh\nv=1.0.0\n```\n').problems, [`no ${MARKER} marker`]);
  });

  test('refuses a block of either language missing before the next heading', () => {
    const text = `${MARKER}\n\n\`\`\`sh\nv=1.0.0\n\`\`\`\n\n## Next\n\n\`\`\`powershell\n$v = '1.0.0'\n\`\`\`\n`;
    assert.deepEqual(blocksOf(text).problems, ['no `powershell` block after the marker']);
  });
});

describe('withVersion', () => {
  test('sets the version line of each language', () => {
    const { blocks } = blocksOf(DOCUMENT);
    assert.equal(
      withVersion(blocks.sh, { language: 'sh', version: '0.17.0' }).block,
      '# a comment, not a heading\nv=0.17.0\necho "$v"\n'
    );
    assert.equal(
      withVersion(blocks.powershell, { language: 'powershell', version: '0.17.0' }).block,
      '# in PowerShell 7.6 (pwsh)\n$v = \'0.17.0\'\n"$v"\n'
    );
  });

  test('keeps a block as written without a version, and refuses a placeholder', () => {
    assert.equal(withVersion('v=0.16.0\n', { language: 'sh' }).block, 'v=0.16.0\n');
    assert.deepEqual(withVersion('v=<version>\n', { language: 'sh' }).problems, [
      "the `sh` block's v=<version> is a placeholder: give --version",
    ]);
  });

  test('refuses a block that names no version', () => {
    assert.equal(withVersion('echo\n', { language: 'powershell' }).problems.length, 1);
  });
});

describe('scriptOf', () => {
  test('appends the line that writes what the block left', () => {
    assert.match(scriptOf('v=1.0.0\n\n', 'sh'), /^v=1\.0\.0\nprintf .*VERIFY_IMAGE_RESULT"\n$/);
    assert.match(scriptOf("$v = '1.0.0'", 'powershell'), /\nSet-Content .*"digest=\$digest"\)\n$/);
  });
});

// ── Judgment ──────────────────────────────────────────────────────────────────

describe('judge', () => {
  test('passes BEADC_IMAGE set to the image by the digest the block resolved', () => {
    const result = resultOf(`BEADC_IMAGE=${IMAGE}@${DIGEST}\ndigest=${DIGEST}\n`);
    assert.deepEqual(judge(result, { language: 'sh' }), []);
    assert.deepEqual(judge(result, { language: 'sh', expected: DIGEST }), []);
  });

  test('fails BEADC_IMAGE unset, a digest other than the one expected, and no digest', () => {
    assert.equal(judge(resultOf(`BEADC_IMAGE=\ndigest=${DIGEST}\n`), { language: 'sh' }).length, 1);
    const result = resultOf(`BEADC_IMAGE=${IMAGE}@${DIGEST}\ndigest=${DIGEST}\n`);
    assert.deepEqual(judge(result, { language: 'sh', expected: OTHER }), [
      `the \`sh\` block resolved ${DIGEST}, not ${OTHER}`,
    ]);
    assert.equal(judge(resultOf('BEADC_IMAGE=\ndigest=\n'), { language: 'powershell' }).length, 1);
    assert.equal(judge(null, { language: 'powershell' }).length, 1);
  });
});

// ── Runs ──────────────────────────────────────────────────────────────────────

describe('runBlock', () => {
  for (const [language, command] of [
    ['sh', 'sh'],
    ['powershell', 'pwsh'],
  ]) {
    test(
      `exports through a ${language} chain that passes, never through one that fails`,
      {
        skip: has(command) ? false : `no ${command}`,
      },
      () => {
        const passed = runBlock(CHAINS[language](true), language);
        assert.deepEqual(judge(passed.result, { language, expected: DIGEST }), []);
        // the caller's BEADC_IMAGE, set, reaches no block
        const before = process.env.BEADC_IMAGE;
        process.env.BEADC_IMAGE = `${IMAGE}@${DIGEST}`;
        try {
          const failed = runBlock(CHAINS[language](false), language);
          assert.equal(failed.result.image, '');
          assert.equal(judge(failed.result, { language }).length, 1);
        } finally {
          if (before === undefined) {
            delete process.env.BEADC_IMAGE;
          } else {
            process.env.BEADC_IMAGE = before;
          }
        }
      }
    );
  }
});
