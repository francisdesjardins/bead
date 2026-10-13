import { expect, test } from '@playwright/test';
import { framesOf } from '../stack';

// definition

test.describe('framesOf', () => {
  test('reads V8’s frames, named or not, and leaves out a line that holds no position', () => {
    expect(
      framesOf(
        [
          'Error',
          '    at callerStackOf (chrome-extension://abc/hook.js:120:12)',
          '    at async onClick (http://localhost:5173/src/page.ts:42:7)',
          '    at http://localhost:5173/src/page.ts:88:3',
          '    at Array.forEach (<anonymous>)',
        ].join('\n')
      )
    ).toEqual([
      {
        column: 12,
        functionName: 'callerStackOf',
        line: 120,
        url: 'chrome-extension://abc/hook.js',
      },
      {
        column: 7,
        functionName: 'async onClick',
        line: 42,
        url: 'http://localhost:5173/src/page.ts',
      },
      { column: 3, functionName: undefined, line: 88, url: 'http://localhost:5173/src/page.ts' },
    ]);
  });

  test('reads SpiderMonkey’s frames, the name left empty for none', () => {
    expect(
      framesOf(
        'onClick@http://localhost:5173/src/page.ts:42:7\n@http://localhost:5173/src/page.ts:88:3'
      )
    ).toEqual([
      { column: 7, functionName: 'onClick', line: 42, url: 'http://localhost:5173/src/page.ts' },
      { column: 3, functionName: undefined, line: 88, url: 'http://localhost:5173/src/page.ts' },
    ]);
    expect(framesOf(undefined)).toEqual([]);
  });
});
