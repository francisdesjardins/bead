import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { type CodeLanguage, type IToken, tokensOf } from '../highlight';

// constants

/** The example the demo's Code view shows, a file a role in each language. */
const EXAMPLES: Readonly<Record<'csharp' | 'rust' | 'typescript', readonly string[]>> = {
  csharp: ['dotnet/Resolvers.cs', 'dotnet/Serving.cs', 'dotnet/Calling.cs'],
  rust: ['rust/src/resolvers.rs', 'rust/src/serving.rs', 'rust/src/calling.rs'],
  typescript: [
    'typescript/src/resolvers.ts',
    'typescript/src/serving.ts',
    'typescript/src/calling.ts',
  ],
};

// helpers

/** The tokens a scanner gives that are coloured, each as `kind text`. */
const colouredOf = (source: string, language: CodeLanguage): string[] => {
  return tokensOf(source, language)
    .filter(({ kind }) => {
      return kind !== 'text';
    })
    .map(({ kind, text }) => {
      return `${kind} ${text}`;
    });
};

const exampleOf = (path: string): Promise<string> => {
  return readFile(new URL(`../../../../examples/hello/${path}`, import.meta.url), 'utf8');
};

// definition

test.describe('tokensOf', () => {
  test('colours TypeScript as the page colours it: comments, strings, numbers and keywords', () => {
    expect(
      colouredOf(
        "const name = 'Ada'; // a caller\nawait hello(0x2a, `a\n${name}`, 1.5e3);",
        'typescript'
      )
    ).toEqual([
      'keyword const',
      "string 'Ada'",
      'comment // a caller',
      'keyword await',
      'number 0x2a',
      'string `a\n${name}`',
      'number 1.5e3',
    ]);
  });

  test('colours .proto, TOML and the shell by the set TypeScript has, their comments by their own mark', () => {
    expect(
      colouredOf('syntax = "proto3";\nrepeated string guests = 5; // up to 8', 'proto')
    ).toEqual([
      'keyword syntax',
      'string "proto3"',
      'keyword repeated',
      'number 5',
      'comment // up to 8',
    ]);
    expect(colouredOf('# the core\nstrict = true', 'toml')).toEqual([
      'comment # the core',
      'keyword true',
    ]);
    expect(colouredOf('curl -s "http://127.0.0.1:8080/hello" # its answer', 'shell')).toEqual([
      'string "http://127.0.0.1:8080/hello"',
      'comment # its answer',
    ]);
  });

  test('colours no keyword in JSON, and nothing in plain text', () => {
    expect(colouredOf('{ "ok": true, "count": 3 }', 'json')).toEqual([
      'string "ok"',
      'string "count"',
      'number 3',
    ]);
    expect(tokensOf('const x = "y"; // z', 'plaintext')).toEqual([
      { kind: 'text', text: 'const x = "y"; // z' },
    ]);
  });

  test('colours C#’s keywords, its interpolated and verbatim strings whole, and its characters', () => {
    expect(
      colouredOf(
        'public static async Task<int> Serve(int port)\n{\n    var line = $"{(port == 0 ? "any" : "one")}: {port}\\n";\n    string.Join(\' \', ticks); // a tick\n    var path = @"C:\\gen\\""x""";\n}',
        'csharp'
      )
    ).toEqual([
      'keyword public',
      'keyword static',
      'keyword async',
      'keyword int',
      'keyword int',
      'keyword var',
      'string $"{(port == 0 ? "any" : "one")}: {port}\\n"',
      'keyword string',
      "string ' '",
      'comment // a tick',
      'keyword var',
      'string @"C:\\gen\\""x"""',
    ]);
    // * TypeScript's own words are not C#'s
    expect(colouredOf('export function type = undefined;', 'csharp')).toEqual([]);
  });

  test('colours Rust’s keywords, its raw strings and its characters, and leaves a lifetime plain', () => {
    expect(
      colouredOf(
        'pub fn locked<\'a, T>(mutex: &\'a Mutex<T>) -> MutexGuard<\'a, T> {\n    let said = r#"{"port":1}"#; //! held\n    match c { \'"\' => 2, _ => 0 }\n}',
        'rust'
      )
    ).toEqual([
      'keyword pub',
      'keyword fn',
      'keyword let',
      'string r#"{"port":1}"#',
      'comment //! held',
      'keyword match',
      "string '\"'",
      'number 2',
      'number 0',
    ]);
    // * TypeScript's own words are not Rust's
    expect(colouredOf('const function = undefined;', 'rust')).toEqual(['keyword const']);
  });

  test('leaves a Rust lifetime plain though its word is a keyword, and keeps the keyword', () => {
    expect(
      colouredOf(
        "static NAME: &'static str = \"hello\";\nfn served() -> impl Future + 'static { 'outer: loop { break 'outer; } }",
        'rust'
      )
    ).toEqual([
      'keyword static',
      'string "hello"',
      'keyword fn',
      'keyword impl',
      'keyword loop',
      'keyword break',
    ]);
    // * a character is still one, the lifetime's mark aside
    expect(colouredOf("let c = 'a'; let s: &'a str;", 'rust')).toEqual([
      'keyword let',
      "string 'a'",
      'keyword let',
    ]);
  });

  test('gives each example the demo shows back whole, no string run past its line', async () => {
    for (const [language, paths] of Object.entries(EXAMPLES)) {
      for (const path of paths) {
        const source = await exampleOf(path);
        const tokens: IToken[] = tokensOf(source, language as CodeLanguage);

        expect(
          tokens
            .map(({ text }) => {
              return text;
            })
            .join(''),
          path
        ).toBe(source);
        // ! a string that ran past its line would colour the code after it
        expect
          .soft(
            tokens.filter(({ kind, text }) => {
              return kind === 'string' && text.includes('\n') && !text.startsWith('`');
            }),
            path
          )
          .toEqual([]);
      }
    }
  });

  test('refuses a language it does not know', () => {
    expect(() => {
      return tokensOf('x', 'cobol' as CodeLanguage);
    }).toThrow('no scanner for cobol');
  });
});
